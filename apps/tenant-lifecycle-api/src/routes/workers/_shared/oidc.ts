/**
 * Shared OIDC validation for `/v1/_workers/*` routes — Cloud Tasks
 * dispatcher authentication per ADR-LIFECYCLE-001 §3.
 *
 * Each worker route runs a per-route middleware that calls the
 * default validator (or a test stub injected via the route's
 * `validateOidc?` build option). The validator verifies the inbound
 * `Authorization: Bearer <token>` is a Google-signed OIDC ID token
 * whose `email` claim matches the configured Cloud Tasks invoker SA.
 *
 * Extracted from `key-rotation.ts` (D.2) at D.4.5 when the
 * provisioning worker route landed as the second consumer. Centralized
 * here so future workers (lifecycle-queue, etc.) inherit the same
 * validation shape without copy-paste drift.
 */

import { OAuth2Client } from 'google-auth-library';

export interface OidcValidationResult {
  ok: boolean;
  reason?: string;
}

export type OidcValidator = (
  authHeader: string | undefined,
  expectedSaEmail: string | undefined,
) => Promise<OidcValidationResult>;

/**
 * Default validator — wraps `google-auth-library`'s
 * `OAuth2Client.verifyIdToken`. Tests inject a stub via the route's
 * `validateOidc?` build option (same DI seam in every worker route
 * per the convention §7.4.0 pattern).
 *
 * Failure modes:
 *   - missing-bearer-token: no `Authorization` header or doesn't
 *     start with `Bearer `.
 *   - empty-bearer-token: `Bearer ` followed by empty / whitespace.
 *   - wrong-issuer: token's `iss` claim is not
 *     `https://accounts.google.com`.
 *   - wrong-issuer-email: `expectedSaEmail` is supplied (non-empty)
 *     and the token's `email` claim doesn't match.
 *   - invalid-token: `verifyIdToken` threw (signature mismatch,
 *     expired, malformed, etc.).
 *
 * `expectedSaEmail` empty / undefined skips the email check — useful
 * for tests, but production routes pass `config.CLOUD_TASKS_INVOKER_SA_EMAIL`.
 */
export const defaultOidcValidator: OidcValidator = async (authHeader, expectedSaEmail) => {
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing-bearer-token' };
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (token === '') {
    return { ok: false, reason: 'empty-bearer-token' };
  }
  try {
    const oauth2 = new OAuth2Client();
    const ticket = await oauth2.verifyIdToken({ idToken: token });
    const payload = ticket.getPayload();
    if (payload?.iss !== 'https://accounts.google.com') {
      return { ok: false, reason: 'wrong-issuer' };
    }
    if (
      expectedSaEmail !== undefined &&
      expectedSaEmail !== '' &&
      payload?.email !== expectedSaEmail
    ) {
      return { ok: false, reason: 'wrong-issuer-email' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid-token' };
  }
};

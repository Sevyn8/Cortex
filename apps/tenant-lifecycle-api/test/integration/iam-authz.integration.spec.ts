/**
 * Integration test: Cloud Run invoker IAM allowlist (F02 Slice D D.5).
 *
 * Skipped unless CORTEX_INTEGRATION_TESTS=true is set. Requires:
 *   - gcloud CLI on PATH + active auth (`gcloud auth login` once per
 *     session, plus tokenCreator on cortex-tf-admin-dev for Case C).
 *   - CORTEX_TENANT_LIFECYCLE_URL env var set to the live Cloud Run
 *     service URL (operator pastes from `gcloud run services describe`).
 *
 * Test pattern: mints OIDC ID tokens via shell-out to gcloud and hits
 * the LIVE Cloud Run dev URL. NOT in-process — the whole point of the
 * three cases is to exercise the Google front-end's invoker-IAM gate
 * (which never reaches the Hono app for the deny case). In-process
 * tests with `app.request()` cannot reproduce this.
 *
 * The 3 cases match `docs/planning/d5-gate-evidence.md`:
 *   A. unauth (no token)               → 403 (Cloud Run platform deny)
 *   B. operator user token             → 200 (user invoker grant)
 *   C. cortex-tf-admin-dev impersonation → 200 (SA invoker grant)
 *
 * NOT run in CI today — CI lacks gcloud auth wiring (D.6 may add it
 * via WIF). For now: operator-run via `CORTEX_INTEGRATION_TESTS=1
 * CORTEX_TENANT_LIFECYCLE_URL=https://... pnpm vitest run` from this
 * package's root. The 3 manual curls in the gate-evidence file are the
 * authoritative D.5 acceptance evidence; this spec is the
 * automation-ready form.
 */
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SKIP = !process.env.CORTEX_INTEGRATION_TESTS;
const SERVICE_URL = process.env.CORTEX_TENANT_LIFECYCLE_URL;

const TF_ADMIN_SA = 'cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com';

function mintUserIdentityToken(): string {
  return execSync('gcloud auth print-identity-token', { encoding: 'utf8' }).trim();
}

function mintImpersonationIdentityToken(saEmail: string, audience: string): string {
  return execSync(
    `gcloud auth print-identity-token --impersonate-service-account=${saEmail} --audiences=${audience}`,
    { encoding: 'utf8' },
  ).trim();
}

async function fetchHealth(token: string | null): Promise<number> {
  const url = `${SERVICE_URL}/health`;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  return response.status;
}

describe.skipIf(SKIP)('integration: Cloud Run invoker IAM (D.5)', () => {
  if (!SKIP && !SERVICE_URL) {
    throw new Error('CORTEX_TENANT_LIFECYCLE_URL must be set when CORTEX_INTEGRATION_TESTS=1');
  }

  it('Case A — unauth (no token) → 403', async () => {
    const status = await fetchHealth(null);
    expect(status).toBe(403);
  });

  it('Case B — operator user token → 200', async () => {
    const token = mintUserIdentityToken();
    const status = await fetchHealth(token);
    expect(status).toBe(200);
  });

  it('Case C — cortex-tf-admin-dev impersonation token → 200', async () => {
    if (!SERVICE_URL) throw new Error('SERVICE_URL guard'); // narrows the type
    const token = mintImpersonationIdentityToken(TF_ADMIN_SA, SERVICE_URL);
    const status = await fetchHealth(token);
    expect(status).toBe(200);
  });
});

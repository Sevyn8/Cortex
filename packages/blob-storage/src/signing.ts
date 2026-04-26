/**
 * Pre-signed URL generation for `@cortex/blob-storage`.
 *
 * Wraps `@google-cloud/storage`'s v4 signing with:
 *   - tenant-prefix enforcement (every signed URL is scoped to
 *     `tenants/{tenantId}/...`)
 *   - schema-validated params (TTL cap at 7 days, action/Content-Type
 *     coupling)
 *   - hybrid DI for testability — factory + module-scope default +
 *     `__setSignerForTesting` / `__resetForTesting` escapes
 *
 * Slice B does NOT emit audit events on signed-URL issuance — the
 * convention doc (sub-phase 9) records this as deferred until a
 * downstream consumer surfaces a need. Callers wrapping this in a
 * higher-level "issue download URL for resource X" flow handle their
 * own audit emission.
 */

import { Storage } from '@google-cloud/storage';
import { BlobStorageConfigError, BlobStorageValidationError } from './errors.js';
import { assertObjectInTenantPrefix, buildFullObjectPath, getTenantBucketName } from './path.js';
import { signedUrlParamsSchema } from './schemas.js';
import type { Environment, SignedUrlParams, SignedUrlResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export interface SignedUrlSigner {
  sign(params: SignedUrlParams): Promise<SignedUrlResult>;
}

export interface CreateSignedUrlSignerOptions {
  /**
   * Pre-configured `@google-cloud/storage` client. Default constructor
   * uses ADC / WIF. Tests inject a stubbed Storage to avoid network
   * calls + GCP credentials.
   */
  storage?: Storage;
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Construct a `SignedUrlSigner` bound to an env (which determines the
 * bucket name). Prefer this factory for new code; legacy callers use
 * the module-scope `generateSignedUrl` convenience export.
 *
 * @throws BlobStorageConfigError if `opts.storage` is supplied but
 *   doesn't implement `bucket(...)` (defensive fail-fast at boot)
 */
export function createSignedUrlSigner(
  env: Environment,
  opts: CreateSignedUrlSignerOptions = {},
): SignedUrlSigner {
  if (opts.storage !== undefined && typeof opts.storage.bucket !== 'function') {
    throw new BlobStorageConfigError(
      'createSignedUrlSigner: opts.storage does not implement the Storage interface',
    );
  }
  const storage = opts.storage ?? new Storage();
  const bucketName = getTenantBucketName(env);

  return {
    async sign(params) {
      // 1. Validate.
      const parsed = signedUrlParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new BlobStorageValidationError(`Invalid signed-URL params: ${parsed.error.message}`, {
          cause: parsed.error,
        });
      }
      const data = parsed.data;

      // 2. Build the full object path. This re-validates objectName
      //    (the schema has refinements that path.ts also checks); the
      //    duplicate validation is intentional — schema for fast-fail
      //    and a clear error path; path.ts as the single funnel
      //    enforcing tenant binding.
      const fullObjectPath = buildFullObjectPath(data.tenantId, data.objectName);

      // 3. Defense in depth: verify the constructed path starts with
      //    the tenant prefix. Catches any future code path that
      //    bypasses buildFullObjectPath.
      assertObjectInTenantPrefix(data.tenantId, fullObjectPath);

      // 4. Generate the signed URL via @google-cloud/storage v4 API.
      //    `expires` is wall-clock ms since epoch.
      const expiresMs = Date.now() + data.expiresInSeconds * 1000;
      const file = storage.bucket(bucketName).file(fullObjectPath);

      const signOpts: {
        version: 'v4';
        action: 'read' | 'write';
        expires: number;
        contentType?: string;
      } = {
        version: 'v4',
        action: data.action,
        expires: expiresMs,
      };
      if (data.action === 'write' && data.contentType !== undefined) {
        signOpts.contentType = data.contentType;
      }

      const [url] = await file.getSignedUrl(signOpts);

      return {
        url,
        expiresAt: new Date(expiresMs),
        fullObjectPath,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Module-scope default + convenience export + test escape hatches
// ─────────────────────────────────────────────────────────────────────

/**
 * Module-scope default signer. Constructed lazily on first use so the
 * `Storage` constructor (which probes ADC) only runs when a caller
 * actually generates a URL. Tests that swap via `__setSignerForTesting`
 * bypass the lazy construction entirely.
 */
let defaultEnv: Environment | null = null;
let defaultSigner: SignedUrlSigner | null = null;

function getDefaultSigner(): SignedUrlSigner {
  if (defaultSigner !== null) return defaultSigner;
  const env = defaultEnv ?? (process.env.CORTEX_ENV as Environment | undefined) ?? 'dev';
  defaultSigner = createSignedUrlSigner(env);
  return defaultSigner;
}

/**
 * Convenience export. Routes through the module-scope default signer
 * (bound to `CORTEX_ENV` env var, defaulting to `'dev'`). For
 * deterministic env binding, callers should use
 * `createSignedUrlSigner(env)` directly.
 *
 * @throws BlobStorageValidationError invalid params
 */
export async function generateSignedUrl(params: SignedUrlParams): Promise<SignedUrlResult> {
  return getDefaultSigner().sign(params);
}

/**
 * @internal
 *
 * Test-only escape: swap the module-scope default signer. Pair with
 * `__resetForTesting()` in `afterEach` to restore. Mirrors the
 * convention in `@cortex/encryption`, `@cortex/audit-events`, etc.
 */
export function __setSignerForTesting(signer: SignedUrlSigner): void {
  defaultSigner = signer;
}

/**
 * @internal
 *
 * Restore the production default signer (lazily constructs on next
 * use; honors `CORTEX_ENV` env var).
 */
export function __resetForTesting(): void {
  defaultSigner = null;
  defaultEnv = null;
}

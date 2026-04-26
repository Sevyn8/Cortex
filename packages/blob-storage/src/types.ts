/**
 * Public types for `@cortex/blob-storage`.
 *
 * Per F01 Slice B planning Decision 4, Phase 1 uses one shared bucket
 * per env (`cortex-{env}-tenant-data`) with object keys conforming to
 * `tenants/{tenantId}/{...path}`. Bucket-per-tenant for the ENTERPRISE
 * tier is deferred to F02; the bucket-name resolver in `path.ts` is the
 * swap point when that lands.
 */

/** Phase 1 environments. ENTERPRISE-tier dedicated buckets land in F02. */
export type Environment = 'dev' | 'staging' | 'prod';

/**
 * The exact prefix every tenant-scoped object key MUST start with.
 * Exposed for consumers that need to validate paths from external
 * sources (e.g., signed-URL audit logs, operator queries).
 */
export const TENANT_PATH_PREFIX = 'tenants/' as const;

/**
 * Caller input to `generateSignedUrl` / `signer.sign`.
 *
 * `objectName` is the path WITHIN the tenant prefix — callers MUST NOT
 * include `tenants/{tenantId}/` themselves; the package prepends it.
 * `objectName` starting with `tenants/` is rejected to force the
 * funneled-call discipline.
 *
 * `expiresInSeconds` is capped server-side at 7 days (per zod schema)
 * to prevent long-lived signed URLs lingering in caches.
 */
export interface SignedUrlParams {
  /** Tenant id (UUID). Becomes the path-prefix segment. */
  tenantId: string;

  /**
   * Object path WITHIN the tenant prefix. MUST NOT start with `/`,
   * contain `..`, contain NUL bytes, or start with `tenants/`.
   */
  objectName: string;

  /** Signed-URL TTL in seconds. Min 1, max 7*24*3600 (7 days). */
  expiresInSeconds: number;

  /** GCS operation the URL authorizes. Phase 1 supports read + write only. */
  action: 'read' | 'write';

  /**
   * Required Content-Type for `action: 'write'`; ignored for `action:
   * 'read'`. The signed URL binds the client to this Content-Type so
   * an upload with a different type is rejected at GCS.
   */
  contentType?: string;
}

/**
 * Result of a successful signed-URL generation. `fullObjectPath`
 * includes the `tenants/{tenantId}/` prefix and is suitable for audit
 * trails and operator forensics.
 */
export interface SignedUrlResult {
  /** The signed HTTPS URL. */
  url: string;

  /**
   * Wall-clock expiration time. Computed as `Date.now() +
   * expiresInSeconds * 1000` at sign time.
   */
  expiresAt: Date;

  /**
   * Full GCS object path including `tenants/{tenantId}/` prefix.
   * Captured for audit / forensic visibility.
   */
  fullObjectPath: string;
}

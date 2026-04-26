/**
 * Path helpers for `@cortex/blob-storage`. Pure functions — no IO, no
 * Storage client, no GCS API calls.
 *
 * Single source of truth for:
 *   - the tenant-prefix shape (`tenants/{tenantId}/`)
 *   - the per-env bucket-name resolution (`cortex-{env}-tenant-data`)
 *   - the full-object-path construction with tenant binding
 *   - cross-tenant-prefix-violation detection
 *
 * All public functions throw `BlobStorageValidationError` on input
 * shape violations rather than returning sentinel values — the
 * cross-tenant escape risk is too high for silent fallbacks.
 */

import { BlobStorageValidationError } from './errors.js';
import { objectNameSchema, tenantIdSchema } from './schemas.js';
import { TENANT_PATH_PREFIX, type Environment } from './types.js';

/**
 * Return the tenant-bound path prefix: `tenants/{tenantId}/`.
 *
 * @throws BlobStorageValidationError invalid tenantId (non-UUID)
 */
export function getTenantPrefix(tenantId: string): string {
  const parsed = tenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new BlobStorageValidationError(`Invalid tenantId: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return `${TENANT_PATH_PREFIX}${parsed.data}/`;
}

/**
 * Return the canonical bucket name for an env. Phase 1: every env
 * shares one tenant-data bucket; F02 may add bucket-per-tenant for
 * ENTERPRISE-tier tenants — when it does, this function becomes a
 * tier-aware resolver.
 */
export function getTenantBucketName(env: Environment): string {
  return `cortex-${env}-tenant-data`;
}

/**
 * Build the full GCS object path: `tenants/{tenantId}/{objectName}`.
 *
 * Validates both the tenantId (UUID) and the objectName (no leading
 * slash, no `..`, no NUL bytes, no `tenants/` prefix). This is the
 * funnel callers MUST use to construct tenant-scoped paths.
 *
 * @throws BlobStorageValidationError invalid tenantId or objectName
 */
export function buildFullObjectPath(tenantId: string, objectName: string): string {
  const parsedTenant = tenantIdSchema.safeParse(tenantId);
  if (!parsedTenant.success) {
    throw new BlobStorageValidationError(`Invalid tenantId: ${parsedTenant.error.message}`, {
      cause: parsedTenant.error,
    });
  }
  const parsedName = objectNameSchema.safeParse(objectName);
  if (!parsedName.success) {
    throw new BlobStorageValidationError(`Invalid objectName: ${parsedName.error.message}`, {
      cause: parsedName.error,
    });
  }
  return `${TENANT_PATH_PREFIX}${parsedTenant.data}/${parsedName.data}`;
}

/**
 * Defense-in-depth assertion: verify a full object path (e.g., one
 * supplied by an external system, or reconstructed from an audit row)
 * starts with the tenant's prefix. Throws otherwise.
 *
 * Used by signing.ts after `buildFullObjectPath` as a redundant check
 * — cheap, catches any future code path that forgets to funnel through
 * the path builder.
 *
 * @throws BlobStorageValidationError full path does not start with the tenant's prefix
 */
export function assertObjectInTenantPrefix(tenantId: string, fullPath: string): void {
  const expectedPrefix = getTenantPrefix(tenantId);
  if (!fullPath.startsWith(expectedPrefix)) {
    throw new BlobStorageValidationError(
      `Object path ${JSON.stringify(fullPath)} does not start with tenant prefix ${JSON.stringify(
        expectedPrefix,
      )}. Cross-tenant access attempt or stale path reference.`,
    );
  }
}

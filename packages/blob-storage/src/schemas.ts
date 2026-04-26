/**
 * Zod schemas for `@cortex/blob-storage`.
 *
 * The schemas validate caller-supplied params (`signedUrlParamsSchema`)
 * and the constituent string fields. Object names are validated for
 * path-traversal / leading-slash / NUL-byte / `tenants/` prefix —
 * rejection is the package's primary enforcement boundary against
 * cross-tenant escape.
 */

import { z } from 'zod';

/** UUID-validated tenant id. */
export const tenantIdSchema = z.string().uuid();

/**
 * Object-name path WITHIN the tenant prefix. Multiple refinements
 * stacked to surface specific failure messages — callers see a clear
 * reason rather than a generic "validation failed".
 *
 * The `tenants/`-prefix rejection is the explicit defense against
 * caller path-construction. Callers MUST funnel through
 * `buildFullObjectPath`; constructing `tenants/{otherTenant}/...`
 * directly bypasses the tenant-prefix-binding intent.
 */
export const objectNameSchema = z
  .string()
  .min(1, 'objectName must be non-empty')
  .max(1024, 'objectName must be <= 1024 chars')
  .refine((s) => !s.startsWith('/'), 'objectName must not start with leading slash')
  .refine((s) => !s.includes('..'), 'objectName must not contain path traversal')
  .refine((s) => !s.includes('\x00'), 'objectName must not contain NUL bytes')
  .refine(
    (s) => !s.startsWith('tenants/'),
    'objectName must not start with tenants/ prefix; use buildFullObjectPath instead',
  );

/** Phase 1 environment enum. */
export const environmentSchema = z.enum(['dev', 'staging', 'prod']);

/** Max signed-URL TTL: 7 days. Above this, prefer rotation. */
const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

/**
 * `SignedUrlParams` schema. `expiresInSeconds` is bounded; `contentType`
 * is optional but RECOMMENDED for `action: 'write'` (the signed URL
 * binds the client to the Content-Type).
 */
export const signedUrlParamsSchema = z.object({
  tenantId: tenantIdSchema,
  objectName: objectNameSchema,
  expiresInSeconds: z
    .number()
    .int()
    .min(1, 'expiresInSeconds must be >= 1')
    .max(MAX_EXPIRES_SECONDS, `expiresInSeconds must be <= ${MAX_EXPIRES_SECONDS} (7 days)`),
  action: z.enum(['read', 'write']),
  contentType: z.string().min(1).optional(),
});

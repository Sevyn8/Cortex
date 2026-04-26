/**
 * Public barrel for `@cortex/blob-storage`.
 *
 * Slice B ships path helpers + signed-URL generation. Object emission
 * (upload / download / delete execution paths) is deferred to the
 * first F-series consumer that needs it; convention: callers use
 * `@google-cloud/storage` directly via the same `Storage` instance,
 * and validate paths through `assertObjectInTenantPrefix` before
 * touching any object.
 */

// Errors + envelope
export {
  BlobStorageError,
  BlobStorageConfigError,
  BlobStorageValidationError,
  toBlobStorageErrorEnvelope,
  type BlobStorageErrorCode,
  type BlobStorageErrorEnvelope,
} from './errors.js';

// Types
export {
  TENANT_PATH_PREFIX,
  type Environment,
  type SignedUrlParams,
  type SignedUrlResult,
} from './types.js';

// Schemas — exposed for callers wanting direct parse access
export { environmentSchema, objectNameSchema, signedUrlParamsSchema } from './schemas.js';

// Path helpers (pure, no IO)
export {
  assertObjectInTenantPrefix,
  buildFullObjectPath,
  getTenantBucketName,
  getTenantPrefix,
} from './path.js';

// Signing — factory + default + convenience + test escapes
export {
  createSignedUrlSigner,
  generateSignedUrl,
  __setSignerForTesting,
  __resetForTesting,
  type CreateSignedUrlSignerOptions,
  type SignedUrlSigner,
} from './signing.js';

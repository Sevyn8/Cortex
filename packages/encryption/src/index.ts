/**
 * Public barrel for `@cortex/encryption`.
 *
 * Sub-phase 3 lands the scaffold: types, errors, zod schemas. The
 * runtime emit path (`encryptForTenant`, `decryptForTenant`, hybrid-DI
 * factory + module-scope default + test escapes) is sub-phase 4.
 * Action catalog (`ENCRYPTION_AUDIT_ACTIONS`) is sub-phase 5.
 */

// Errors + envelope
export {
  EncryptionError,
  EncryptionValidationError,
  EncryptionExecutionError,
  EncryptionConfigError,
  toEncryptionErrorEnvelope,
  type EncryptionErrorCode,
  type EncryptionErrorEnvelope,
} from './errors.js';

// Types
export {
  ENCRYPTION_PAYLOAD_VERSION,
  type DecryptParams,
  type EncryptParams,
  type EncryptedPayload,
} from './types.js';

// Schemas — exposed for callers wanting direct parse access
export { decryptParamsSchema, encryptParamsSchema, encryptedPayloadSchema } from './schemas.js';

// Catalog — registered action set
export { ENCRYPTION_AUDIT_ACTIONS, type EncryptionAuditAction } from './catalog.js';

// Emitter — factory + default + convenience + test escapes
export {
  createEncryptionEmitter,
  decryptForTenant,
  encryptForTenant,
  __setEmitterForTesting,
  __resetForTesting,
  type CreateEncryptionEmitterOptions,
  type EncryptForTenant,
} from './encrypt.js';

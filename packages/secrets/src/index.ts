export { secrets } from './secret-manager.js';
export type { GetOptions, PutResult } from './secret-manager.js';
export { envelope } from './kms.js';
export { getKeyForTenant } from './per-tenant-keys.js';
export {
  SecretsError,
  SecretsValidationError,
  ConfigError,
  SecretNotFoundError,
  PermissionDeniedError,
  EnvelopeEncryptError,
  EnvelopeDecryptError,
  KmsUnavailableError,
} from './errors.js';
export type { SecretsErrorCode } from './errors.js';

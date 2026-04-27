export { secrets } from './secret-manager.js';
export type { GetOptions, PutResult } from './secret-manager.js';
export { envelope } from './kms.js';
export { getKeyForTenant } from './per-tenant-keys.js';
/**
 * Builds the canonical Cloud KMS resource name for a key id, resolving
 * GCP project / location / keyring from environment configuration.
 * Consumed by `@cortex/encryption` and `@cortex/tenant-context` as part
 * of the per-tenant CMEK substrate per ADR-INFRA-007.
 */
export { buildKeyResourceName } from './config.js';
/**
 * Test-only escape hatch — replaces the KMS client factory with a
 * caller-supplied stub. Used by `@cortex/encryption`'s integration
 * tests (and any future package that needs to exercise envelope
 * encrypt/decrypt against a deterministic KMS without GCP auth).
 *
 * Production code MUST NOT call this. The `__` prefix is the
 * established workspace convention marking test-only API.
 *
 * See `packages/secrets/test/kms.spec.ts` for the canonical
 * `inMemoryKms()` factory shape.
 */
export { __setClientFactoryForTesting } from './kms.js';
export {
  SecretsError,
  SecretsValidationError,
  ConfigError,
  SecretNotFoundError,
  PermissionDeniedError,
  EnvelopeEncryptError,
  EnvelopeDecryptError,
  KmsUnavailableError,
  TenantKmsKeyNotFoundError,
} from './errors.js';
export type { SecretsErrorCode } from './errors.js';

/**
 * Error hierarchy for `@cortex/encryption`.
 *
 * All errors extend `EncryptionError`. Callers can `instanceof
 * EncryptionError` to catch any package-emitted failure, or narrow on
 * `.code` to discriminate. Subclasses set `.name` so stack traces and
 * JSON serialization carry the specific class identity.
 *
 * Mirrors the shape of `@cortex/audit-events`'s error hierarchy
 * (per-package error classes share this convention across the
 * workspace).
 */

export type EncryptionErrorCode = 'VALIDATION' | 'EXECUTION_FAILED' | 'CONFIG_INVALID';

export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;

  constructor(code: EncryptionErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'EncryptionError';
  }
}

/**
 * Thrown for validation failures: malformed `EncryptParams` /
 * `DecryptParams` (non-UUID tenantId, empty plaintext, missing payload
 * fields, zero-byte buffers), or `EncryptedPayload` shape mismatches at
 * the schema layer. Cause is the underlying `ZodError` when available;
 * consumers can walk `cause.issues` for field-level detail.
 */
export class EncryptionValidationError extends EncryptionError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'EncryptionValidationError';
  }
}

/**
 * Thrown when the encrypt or decrypt path fails at runtime: KMS API
 * failure (wrap / unwrap), AEAD auth-tag mismatch on decrypt
 * (cross-tenant smuggling, tampered ciphertext), key-resolution failure
 * (`getKeyForTenant` raised), or any other downstream-cryptographic
 * boundary error. Cause carries the underlying secrets-layer or KMS
 * driver error.
 *
 * Auth-tag failures are surfaced here (NOT as a separate
 * `EncryptionAuthTagError`) — the cryptographic system already treats
 * tampering and wrong-tenant-AAD as the same failure mode (both flip
 * the same authentication-tag-verify bit). Distinguishing them at the
 * error-class level would suggest the application can recover
 * differently, which it cannot.
 */
export class EncryptionExecutionError extends EncryptionError {
  constructor(message: string, options?: { cause?: Error }) {
    super('EXECUTION_FAILED', message, options);
    this.name = 'EncryptionExecutionError';
  }
}

/**
 * Thrown for invalid factory options: bad `moduleId`, malformed audit
 * emitter, or any other configuration-time mistake before encrypt/
 * decrypt can begin. Distinct from `EXECUTION_FAILED` so callers can
 * fail-fast at boot rather than at first crypto op.
 */
export class EncryptionConfigError extends EncryptionError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONFIG_INVALID', message, options);
    this.name = 'EncryptionConfigError';
  }
}

/**
 * Standard error envelope for encryption failures surfaced to higher
 * layers. Mirrors the shape of `@cortex/audit-events`'s
 * `AuditEventErrorEnvelope` and `@cortex/observability`'s
 * `ErrorEnvelope` with `correlation_id` threading. `details` carries
 * optional field-level context (e.g., the offending tenantId, the
 * key resource name attempted, the KMS error code).
 */
export interface EncryptionErrorEnvelope {
  code: string;
  message: string;
  correlation_id: string;
  details?: Record<string, unknown>;
}

/**
 * Convert any `Error` to the canonical `EncryptionErrorEnvelope`. If
 * `err` carries a `.code` field (any of our `EncryptionError`
 * subclasses), it is preserved; otherwise the code defaults to
 * `INTERNAL`. The envelope's `message` is the error's `.message` only —
 * never the stack trace.
 */
export function toEncryptionErrorEnvelope(
  err: Error,
  correlation_id: string,
  details?: Record<string, unknown>,
): EncryptionErrorEnvelope {
  const codeFromErr = (err as { code?: unknown }).code;
  const code = typeof codeFromErr === 'string' && codeFromErr.length > 0 ? codeFromErr : 'INTERNAL';
  const envelope: EncryptionErrorEnvelope = { code, message: err.message, correlation_id };
  if (details !== undefined) {
    envelope.details = details;
  }
  return envelope;
}

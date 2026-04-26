/**
 * Error hierarchy for `@cortex/blob-storage`.
 *
 * Mirrors the workspace convention (`@cortex/audit-events`,
 * `@cortex/encryption`): a base `BlobStorageError` with a `.code`
 * discriminator and per-code subclasses.
 *
 * Slice B ships path helpers + signed-URL generation only — no upload /
 * download / delete execution paths. When sub-phase 7 (or a future
 * iteration) adds object emission, a `BlobStorageExecutionError` class
 * will land here for KMS / GCS API failures.
 */

export type BlobStorageErrorCode = 'VALIDATION' | 'CONFIG_INVALID';

export class BlobStorageError extends Error {
  readonly code: BlobStorageErrorCode;

  constructor(code: BlobStorageErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'BlobStorageError';
  }
}

/**
 * Thrown for validation failures: malformed object names (path
 * traversal, leading slash, NUL byte, `tenants/` prefix attempt),
 * non-UUID tenantIds, out-of-range expiry, schema parse failures.
 * Cause is the underlying `ZodError` when available.
 */
export class BlobStorageValidationError extends BlobStorageError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'BlobStorageValidationError';
  }
}

/**
 * Thrown for invalid factory options: bad bucket name, missing env
 * config, malformed Storage client, etc. Distinct from `VALIDATION` so
 * callers can fail-fast at boot rather than at first signed-URL call.
 */
export class BlobStorageConfigError extends BlobStorageError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONFIG_INVALID', message, options);
    this.name = 'BlobStorageConfigError';
  }
}

/**
 * Standard error envelope for blob-storage failures surfaced to higher
 * layers. Mirrors the shape of `@cortex/audit-events`'s
 * `AuditEventErrorEnvelope`. `details` carries optional field-level
 * context (offending object name, tenantId, etc.).
 */
export interface BlobStorageErrorEnvelope {
  code: string;
  message: string;
  correlation_id: string;
  details?: Record<string, unknown>;
}

/**
 * Convert any `Error` to the canonical `BlobStorageErrorEnvelope`. If
 * `err` carries a `.code` field (any of our `BlobStorageError`
 * subclasses), it is preserved; otherwise the code defaults to
 * `INTERNAL`. The envelope's `message` is the error's `.message` only —
 * never the stack trace.
 */
export function toBlobStorageErrorEnvelope(
  err: Error,
  correlation_id: string,
  details?: Record<string, unknown>,
): BlobStorageErrorEnvelope {
  const codeFromErr = (err as { code?: unknown }).code;
  const code = typeof codeFromErr === 'string' && codeFromErr.length > 0 ? codeFromErr : 'INTERNAL';
  const envelope: BlobStorageErrorEnvelope = { code, message: err.message, correlation_id };
  if (details !== undefined) {
    envelope.details = details;
  }
  return envelope;
}

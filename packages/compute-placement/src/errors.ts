/**
 * Error hierarchy for `@cortex/compute-placement`.
 *
 * Mirrors the workspace convention (`@cortex/quotas`,
 * `@cortex/encryption`): a base `ComputePlacementError` with a
 * `.code` discriminator and per-code subclasses.
 */

export type ComputePlacementErrorCode = 'VALIDATION' | 'CONFIG_INVALID';

export class ComputePlacementError extends Error {
  readonly code: ComputePlacementErrorCode;

  constructor(code: ComputePlacementErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'ComputePlacementError';
  }
}

/**
 * Thrown for validation failures: malformed `GetComputePlacementParams`
 * (non-UUID tenantId, invalid env, workload regex violation), or a
 * Cloud Run service name supplied to `parseCloudRunServiceName` that
 * exceeds the 63-char limit or doesn't match Cortex naming conventions.
 * Cause is the underlying `ZodError` when available.
 */
export class ComputePlacementValidationError extends ComputePlacementError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'ComputePlacementValidationError';
  }
}

/**
 * Reserved for F02-side configuration failures (e.g., tenant lookup
 * fails when consulting `tenant.tier` for placement). Phase 1 unused.
 */
export class ComputePlacementConfigError extends ComputePlacementError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONFIG_INVALID', message, options);
    this.name = 'ComputePlacementConfigError';
  }
}

/**
 * Standard error envelope for compute-placement failures surfaced to
 * higher layers. Mirrors the shape of `@cortex/quotas`'s
 * `QuotaErrorEnvelope`. `details` carries optional field-level context
 * (offending workload, tenantId, etc.).
 */
export interface ComputePlacementErrorEnvelope {
  code: string;
  message: string;
  correlation_id: string;
  details?: Record<string, unknown>;
}

/**
 * Convert any `Error` to the canonical `ComputePlacementErrorEnvelope`.
 * If `err` carries a `.code` field (any of our `ComputePlacementError`
 * subclasses), it is preserved; otherwise the code defaults to
 * `INTERNAL`. The envelope's `message` is the error's `.message` only —
 * never the stack trace.
 */
export function toComputePlacementErrorEnvelope(
  err: Error,
  correlation_id: string,
  details?: Record<string, unknown>,
): ComputePlacementErrorEnvelope {
  const codeFromErr = (err as { code?: unknown }).code;
  const code = typeof codeFromErr === 'string' && codeFromErr.length > 0 ? codeFromErr : 'INTERNAL';
  const envelope: ComputePlacementErrorEnvelope = { code, message: err.message, correlation_id };
  if (details !== undefined) {
    envelope.details = details;
  }
  return envelope;
}

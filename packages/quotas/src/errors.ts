/**
 * Error hierarchy for `@cortex/quotas`.
 *
 * All errors extend `QuotaError`. Callers can `instanceof QuotaError`
 * to catch any package-emitted failure, or narrow on `.code` to
 * discriminate. Subclasses set `.name` so stack traces and JSON
 * serialization carry the specific class identity.
 *
 * Mirrors the workspace convention (`@cortex/audit-events`,
 * `@cortex/encryption`, `@cortex/blob-storage`).
 *
 * **Note on `QuotaExceededError`:** unlike the other subclasses, this
 * one is NOT a developer-facing failure. It is the canonical "this
 * request must be rejected with 429" signal. The HTTP middleware
 * catches it explicitly to convert to a 429 response with the
 * `Retry-After` header derived from `retryAfterSeconds`. Service-level
 * callers may catch it and apply other policies (queue + retry,
 * shed-load, etc.). Never log this as an "error" at ERROR severity —
 * it's a normal rejection signal.
 */

export type QuotaErrorCode =
  | 'VALIDATION'
  | 'QUOTA_EXCEEDED'
  | 'EXECUTION_FAILED'
  | 'CONFIG_INVALID';

export class QuotaError extends Error {
  readonly code: QuotaErrorCode;

  constructor(code: QuotaErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'QuotaError';
  }
}

/**
 * Thrown for validation failures: malformed `CheckQuotaParams`
 * (non-UUID tenantId, unknown resource_class, negative `increment`),
 * missing tenant binding, or schema parse failures. Cause is the
 * underlying `ZodError` when available.
 */
export class QuotaValidationError extends QuotaError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'QuotaValidationError';
  }
}

/**
 * Thrown when the tenant's token bucket for a `(resource_class,
 * window)` is exhausted. Carries the forensic data the HTTP middleware
 * (or service-level callers) need to construct a 429 response:
 *
 * - `currentValue`: the post-increment counter value (>= `quotaLimit`).
 * - `quotaLimit`: the per-tier limit applied at check time.
 * - `retryAfterSeconds`: seconds until the current window rolls over;
 *    HTTP `Retry-After` header value.
 *
 * NOT an "error" in the developer sense — see file header. The
 * middleware adapter pattern catches this explicitly and produces
 * the 429 response; logging at ERROR severity would be misleading.
 */
export class QuotaExceededError extends QuotaError {
  readonly currentValue: bigint;
  readonly quotaLimit: bigint;
  readonly retryAfterSeconds: number;

  constructor(
    message: string,
    details: { currentValue: bigint; quotaLimit: bigint; retryAfterSeconds: number },
    options?: { cause?: Error },
  ) {
    super('QUOTA_EXCEEDED', message, options);
    this.name = 'QuotaExceededError';
    this.currentValue = details.currentValue;
    this.quotaLimit = details.quotaLimit;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/**
 * Thrown when the token-bucket DB upsert fails: connection-level pg
 * driver error, RLS-denied INSERT (no tenant binding), CHECK
 * constraint violation, etc. Cause is the underlying `pg` driver
 * error for forensic chasing.
 */
export class QuotaExecutionError extends QuotaError {
  constructor(message: string, options?: { cause?: Error }) {
    super('EXECUTION_FAILED', message, options);
    this.name = 'QuotaExecutionError';
  }
}

/**
 * Thrown for invalid factory options: bad logger config, unknown
 * resource class registered in custom defaults, or any other
 * configuration-time mistake before quota checks can begin. Distinct
 * from `EXECUTION_FAILED` so callers can fail-fast at boot rather
 * than at first quota check.
 */
export class QuotaConfigError extends QuotaError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONFIG_INVALID', message, options);
    this.name = 'QuotaConfigError';
  }
}

/**
 * Standard error envelope for quota failures surfaced to higher
 * layers. Mirrors the shape of `@cortex/audit-events`'s
 * `AuditEventErrorEnvelope`. `details` carries optional field-level
 * context (offending tenantId, resource class, current value, etc.).
 *
 * `bigint` values in `details` should be converted to `string` (or
 * `number` if safely below `Number.MAX_SAFE_INTEGER`) before
 * serialization — JSON.stringify does NOT serialize bigint by default.
 * The `Retry-After` HTTP header expects an integer second count;
 * `retryAfterSeconds` on `QuotaExceededError` is already `number` for
 * exactly this reason.
 */
export interface QuotaErrorEnvelope {
  code: string;
  message: string;
  correlation_id: string;
  details?: Record<string, unknown>;
}

/**
 * Convert any `Error` to the canonical `QuotaErrorEnvelope`. If
 * `err` carries a `.code` field (any of our `QuotaError` subclasses),
 * it is preserved; otherwise the code defaults to `INTERNAL`. The
 * envelope's `message` is the error's `.message` only — never the
 * stack trace.
 */
export function toQuotaErrorEnvelope(
  err: Error,
  correlation_id: string,
  details?: Record<string, unknown>,
): QuotaErrorEnvelope {
  const codeFromErr = (err as { code?: unknown }).code;
  const code = typeof codeFromErr === 'string' && codeFromErr.length > 0 ? codeFromErr : 'INTERNAL';
  const envelope: QuotaErrorEnvelope = { code, message: err.message, correlation_id };
  if (details !== undefined) {
    envelope.details = details;
  }
  return envelope;
}

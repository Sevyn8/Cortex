/**
 * Error hierarchy for `@cortex/audit-events`.
 *
 * All errors extend `AuditEventError`. Callers can `instanceof
 * AuditEventError` to catch any package-emitted failure, or narrow on
 * `.code` to discriminate. Subclasses set `.name` so stack traces and
 * JSON serialization carry the specific class identity.
 *
 * Mirrors the shape of `@cortex/observability`'s error hierarchy.
 *
 * Plus a canonical envelope `AuditEventErrorEnvelope` for surfacing
 * audit-emission failures on the wire (or in higher-level error
 * responses) without leaking stack traces.
 */

export type AuditEventErrorCode = 'VALIDATION' | 'EMISSION_FAILED' | 'CONFIG_INVALID';

export class AuditEventError extends Error {
  readonly code: AuditEventErrorCode;

  constructor(code: AuditEventErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'AuditEventError';
  }
}

/**
 * Thrown for validation failures: invalid action name (regex / brand),
 * invalid actor type, malformed payload (non-JSON-safe value, oversized
 * string at the schema layer), or missing required state fields per the
 * verb's discriminated-union contract (CREATE missing `after_state`,
 * UPDATE missing `before_state` or `after_state`, etc.).
 *
 * Cause is the underlying ZodError (or other validation source) when
 * available; consumers can walk `cause.issues` for field-level detail.
 */
export class AuditEventValidationError extends AuditEventError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'AuditEventValidationError';
  }
}

/**
 * Thrown when the parameterized INSERT into `audit_event` fails:
 * RLS-denied (tenant context not bound, SQLSTATE 42501), CHECK violation
 * (actor_type / etc.), connection-level errors, etc. Cause is the
 * underlying `pg` driver error for forensic chasing.
 */
export class AuditEventEmissionError extends AuditEventError {
  constructor(message: string, options?: { cause?: Error }) {
    super('EMISSION_FAILED', message, options);
    this.name = 'AuditEventEmissionError';
  }
}

/**
 * Thrown for invalid factory options: bad `moduleId`, malformed logger
 * config, or any other configuration-time mistake before emission can
 * begin. Distinct from `EMISSION_FAILED` so callers can fail-fast at
 * boot rather than at first emit.
 */
export class AuditEventConfigError extends AuditEventError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONFIG_INVALID', message, options);
    this.name = 'AuditEventConfigError';
  }
}

/**
 * Standard error envelope for audit-emission failures surfaced to higher
 * layers. Mirrors the shape of `@cortex/observability`'s `ErrorEnvelope`
 * with `correlation_id` threading. `details` carries optional
 * field-level context (e.g., the offending action name, the failed
 * payload field path).
 */
export interface AuditEventErrorEnvelope {
  code: string;
  message: string;
  correlation_id: string;
  details?: Record<string, unknown>;
}

/**
 * Convert any `Error` to the canonical `AuditEventErrorEnvelope`. If
 * `err` carries a `.code` field (any of our `AuditEventError`
 * subclasses), it is preserved; otherwise the code defaults to
 * `INTERNAL`. The envelope's `message` is the error's `.message` only —
 * never the stack trace.
 */
export function toAuditEventErrorEnvelope(
  err: Error,
  correlation_id: string,
  details?: Record<string, unknown>,
): AuditEventErrorEnvelope {
  const codeFromErr = (err as { code?: unknown }).code;
  const code = typeof codeFromErr === 'string' && codeFromErr.length > 0 ? codeFromErr : 'INTERNAL';
  const envelope: AuditEventErrorEnvelope = { code, message: err.message, correlation_id };
  if (details !== undefined) {
    envelope.details = details;
  }
  return envelope;
}

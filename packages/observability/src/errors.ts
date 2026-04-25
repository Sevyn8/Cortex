/**
 * Error hierarchy for @cortex/observability.
 *
 * All errors extend `ObservabilityError`. Callers can `instanceof
 * ObservabilityError` to catch any package-emitted failure, or narrow on
 * `.code` to discriminate. Subclasses set `.name` so stack traces and
 * JSON serialization carry the specific class identity.
 *
 * Plus the canonical HTTP/gRPC error envelope (`ErrorEnvelope`) per the
 * F-series build prompt convention — every error response on the wire
 * uses this shape.
 */

export type ObservabilityErrorCode =
  | 'CONFIG_INVALID'
  | 'EXPORT_FAILED'
  | 'CONTEXT_INVALID'
  | 'VALIDATION';

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;

  constructor(code: ObservabilityErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'ObservabilityError';
  }
}

/**
 * Thrown for invalid logger / tracer / metrics options at construction
 * time — missing `moduleId`, malformed OTLP endpoint, conflicting
 * config, etc.
 */
export class ObservabilityConfigError extends ObservabilityError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONFIG_INVALID', message, options);
    this.name = 'ObservabilityConfigError';
  }
}

/**
 * Thrown for emission-time failures: OTLP export errors, Cloud Logging
 * destination errors, anything that fails AFTER construction succeeded.
 */
export class ObservabilityExportError extends ObservabilityError {
  constructor(message: string, options?: { cause?: Error }) {
    super('EXPORT_FAILED', message, options);
    this.name = 'ObservabilityExportError';
  }
}

/**
 * Thrown when a `ContextProvider` returns a malformed value — wrong
 * type, oversized string, non-UUID where one is required, etc.
 */
export class ObservabilityContextError extends ObservabilityError {
  constructor(message: string, options?: { cause?: Error }) {
    super('CONTEXT_INVALID', message, options);
    this.name = 'ObservabilityContextError';
  }
}

/**
 * Thrown for bad input to factory functions — invalid `moduleId`
 * format, malformed metric name, etc.
 */
export class ObservabilityValidationError extends ObservabilityError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'ObservabilityValidationError';
  }
}

/**
 * Standard error response shape used on the wire for HTTP / gRPC
 * surfaces. Per the F-series build-prompts convention. `correlation_id`
 * threads the same id from logs / traces, letting operators jump from a
 * customer-supplied error response to the request's full log + trace.
 */
export interface ErrorEnvelope {
  code: string;
  message: string;
  correlation_id: string;
  details?: Record<string, unknown>;
}

/**
 * Convert any `Error` to the canonical `ErrorEnvelope`. If `err` carries
 * a `.code` field (any of our `ObservabilityError` subclasses, or other
 * codes set by upstream packages), it is preserved; otherwise the code
 * defaults to `INTERNAL`.
 *
 * The envelope's `message` is the error's `.message` only — never the
 * stack trace. Stacks belong in logs (server-side), not on the wire.
 */
export function toErrorEnvelope(
  err: Error,
  correlation_id: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  const codeFromErr = (err as { code?: unknown }).code;
  const code = typeof codeFromErr === 'string' && codeFromErr.length > 0 ? codeFromErr : 'INTERNAL';
  const envelope: ErrorEnvelope = { code, message: err.message, correlation_id };
  if (details !== undefined) {
    envelope.details = details;
  }
  return envelope;
}

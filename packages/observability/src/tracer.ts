/**
 * Tracer factory + OTel context bridge for `ContextProvider`.
 *
 * Thin layer over `@opentelemetry/api` — OTel's tracer surface is
 * already idiomatic. Consumers call `tracer.startSpan(...)`,
 * `span.setAttribute(...)`, `span.setStatus({...})`, `span.end()`.
 * `withSpan` wraps the start / try / catch / end pattern; preferred for
 * any new code path.
 *
 * `getCurrentTraceId` / `getCurrentSpanId` read the active span from
 * OTel's context API — used by `defaultContextProvider` to enrich every
 * log line + metric with the current trace + span ids without callers
 * threading them by hand.
 */

import {
  context,
  SpanStatusCode,
  trace,
  type Span,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api';
import { ObservabilityConfigError, ObservabilityValidationError } from './errors.js';
import { moduleId } from './types.js';

const TRACER_VERSION = '0.0.0';

export interface CreateTracerOptions {
  /**
   * Service identifier — slug per `moduleId(value)`. Becomes the
   * tracer's instrumentation library name.
   */
  moduleId: string;
}

/**
 * Construct a tracer scoped to a service. The OTel API's tracer
 * registry caches by `(name, version)`, so calling this multiple times
 * with the same `moduleId` returns the same underlying tracer.
 *
 * @throws ObservabilityConfigError — invalid `moduleId`.
 */
export function createTracer(options: CreateTracerOptions): Tracer {
  let validatedModuleId: string;
  try {
    validatedModuleId = moduleId(options.moduleId);
  } catch (err) {
    if (err instanceof ObservabilityValidationError) {
      throw new ObservabilityConfigError(`Invalid moduleId: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
  return trace.getTracer(validatedModuleId, TRACER_VERSION);
}

/**
 * Returns the trace id of the currently active span (per OTel's context
 * propagation), or `undefined` if no span is active.
 *
 * Wired into `defaultContextProvider.getTraceId` so logs + metrics auto-
 * tag with the current trace.
 */
export function getCurrentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (span === undefined) return undefined;
  const ctx = span.spanContext();
  return ctx.traceId;
}

/**
 * Returns the span id of the currently active span, or `undefined` if
 * no span is active.
 */
export function getCurrentSpanId(): string | undefined {
  const span = trace.getActiveSpan();
  if (span === undefined) return undefined;
  const ctx = span.spanContext();
  return ctx.spanId;
}

/**
 * Run `fn` inside a span. The span is set as active for `fn`'s async
 * subtree, so any `getActiveSpan()` calls (and downstream auto-
 * instrumentation) see it as the parent. Status is set to ERROR + the
 * exception is recorded if `fn` throws; the original error is rethrown.
 * Span is always ended in `finally`.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => T | Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const span = tracer.startSpan(name, options);
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (err) {
    if (err instanceof Error) {
      span.recordException(err);
    }
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

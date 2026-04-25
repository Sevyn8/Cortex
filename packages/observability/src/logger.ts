/**
 * Pino-backed structured logger factory for Cortex services.
 *
 * Output format: Cloud Logging-compatible JSON. Field shape:
 *   - `severity` — Cloud Logging severity (`DEBUG` | `INFO` | …) mapped
 *     from pino's level label by the level formatter.
 *   - `timestamp` — RFC 3339 / ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 *   - `message` — primary log text. (Pino's default key `msg` renamed
 *     via `messageKey` to align with Cloud Logging's auto-detection.)
 *   - All structured fields land in `jsonPayload` automatically — Cloud
 *     Logging treats unrecognized top-level keys as the payload.
 *
 * Context injection: a `mixin` runs on every emission, calling the
 * supplied `ContextProvider` and merging present (non-`undefined`)
 * fields into the log line. Module id is always present.
 *
 * Per ADR-OBS-001 §Decision 1+2+5.
 */

import pino from 'pino';
import { defaultContextProvider, type ContextProvider } from './context-provider.js';
import { ObservabilityConfigError, ObservabilityValidationError } from './errors.js';
import { buildRedactionConfig } from './redaction.js';
import { moduleId, type ModuleId, type Severity } from './types.js';

/**
 * Re-export pino's `Logger` so consumers don't need a direct pino
 * dependency to type the return value.
 */
export type Logger = pino.Logger;

export interface CreateLoggerOptions {
  /**
   * Service identifier — slug per `moduleId(value)` validator. Example:
   * `'cortex-foundation'`, `'cortex-tenant-lifecycle'`.
   */
  moduleId: string;

  /**
   * Pino level. Defaults: `'info'` in production, `'debug'` elsewhere.
   */
  level?: pino.LevelWithSilent;

  /**
   * Provides context fields (`tenant_id`, `user_id`, `correlation_id`,
   * `trace_id`, `span_id`) to every log emission. Defaults to
   * `defaultContextProvider`. Pass `stubContextProvider` in tests where
   * coupling to async-local stores would add noise.
   */
  contextProvider?: ContextProvider;

  /**
   * Additional redaction paths concatenated with the canonical default
   * set. See `redaction.ts` for the default paths and pino redaction
   * docs for path syntax.
   */
  extraRedactionPaths?: readonly string[];

  /**
   * Output stream. Defaults to a fast SonicBoom destination wrapping
   * stdout. Tests pass `pino.destination({ sync: true, dest: <stream> })`
   * to capture log lines for assertion.
   */
  destination?: pino.DestinationStream;
}

/**
 * Map pino level labels (trace/debug/info/warn/error/fatal) onto Cloud
 * Logging severities. Unknown labels degrade to `INFO`.
 */
const SEVERITY_BY_PINO_LABEL: Record<string, Severity> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

const cloudLoggingFormatters: NonNullable<pino.LoggerOptions['formatters']> = {
  level(label) {
    return { severity: SEVERITY_BY_PINO_LABEL[label] ?? 'INFO' };
  },
  bindings(bindings) {
    // Strip pino's default `pid` + `hostname` so they don't pollute the
    // Cloud Logging jsonPayload. Preserve any other bindings (e.g.,
    // child-logger context the consumer attached).
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bindings)) {
      if (key === 'pid' || key === 'hostname') continue;
      result[key] = value;
    }
    return result;
  },
};

/**
 * Custom timestamp function — emits `,"timestamp":"<iso>"` instead of
 * pino's default `,"time":"<iso>"`. Cloud Logging recognizes
 * `timestamp` as the canonical field name for `LogEntry.timestamp`.
 */
function isoTimestamp(): string {
  return `,"timestamp":"${new Date().toISOString()}"`;
}

/**
 * Construct a logger. Validates inputs at construction time; emission
 * is hot-path and must not throw on bad context.
 *
 * @throws ObservabilityConfigError — invalid `moduleId` or other
 * options.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  let validatedModuleId: ModuleId;
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

  const provider = options.contextProvider ?? defaultContextProvider;

  const mixin = (): Record<string, string> => {
    const fields: Record<string, string> = { module_id: validatedModuleId };
    const tenantId = provider.getTenantId();
    if (tenantId !== undefined) fields.tenant_id = tenantId;
    const userId = provider.getUserId();
    if (userId !== undefined) fields.user_id = userId;
    const correlationId = provider.getCorrelationId();
    if (correlationId !== undefined) fields.correlation_id = correlationId;
    const traceId = provider.getTraceId();
    if (traceId !== undefined) fields.trace_id = traceId;
    const spanId = provider.getSpanId();
    if (spanId !== undefined) fields.span_id = spanId;
    return fields;
  };

  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    formatters: cloudLoggingFormatters,
    timestamp: isoTimestamp,
    // Cloud Logging's special-payload-fields documentation expects
    // `message` as the primary text field (pino default is `msg`).
    messageKey: 'message',
    redact: buildRedactionConfig(options.extraRedactionPaths),
    mixin,
    // `null` (not undefined) suppresses the default { pid, hostname }
    // base bindings. Belt-and-braces with the bindings formatter above:
    // the formatter handles future override-via-base cases too.
    base: null,
  };

  const destination = options.destination ?? pino.destination(1);
  return pino(pinoOptions, destination);
}

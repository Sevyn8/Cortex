/**
 * Framework-agnostic HTTP middleware for @cortex/observability.
 *
 * Establishes per-request observability context: extracts (or generates)
 * a `correlation_id`, opens a SERVER-kind OTel span for the request, and
 * runs the downstream handler chain inside both the correlation_id
 * AsyncLocalStorage AND the OTel span context. Logs, metrics, and child
 * spans emitted by downstream code automatically inherit
 * `correlation_id`, `trace_id`, `span_id` — plus `tenant_id` if the
 * caller already wrapped this middleware with F01's tenant-context
 * middleware.
 *
 * Composition order (recommended):
 *   observability → tenant-context → handler
 * Observability outermost so any logs emitted by tenant-context (or any
 * future cross-cutting middleware) carry the correlation_id.
 *
 * The middleware does NOT log requests itself — that's the consumer's
 * job using the logger. We only establish context.
 *
 * Mirrors F01's `buildTenantContextMiddleware` shape: structural Like
 * interfaces, no Hono / Express runtime imports.
 */

import { context, SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { ObservabilityConfigError, ObservabilityValidationError } from './errors.js';
import { generateCorrelationId, withCorrelationContext } from './correlation-context.js';
import { createTracer } from './tracer.js';
import type { Logger } from './logger.js';
import { moduleId, type ModuleId } from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const CORRELATION_HEADER = 'x-correlation-id';
const REQUEST_ID_HEADER = 'x-request-id';

const DEFAULT_SKIP_PATHS: readonly string[] = ['/health', '/healthz', '/readiness', '/liveness'];

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Pulls a correlation_id out of an incoming request's headers. Return
 * `undefined` if no candidate is present (the middleware decides what
 * to do based on `generateIfMissing`).
 */
export type CorrelationExtractor = (request: {
  headers: Record<string, string | string[] | undefined>;
}) => string | undefined;

/**
 * Default extractor — reads `x-correlation-id` (case-insensitive),
 * falls back to `x-request-id`. First entry wins for multi-value
 * headers. Empty strings are treated as absent.
 */
export const defaultCorrelationExtractor: CorrelationExtractor = ({ headers }) => {
  return readHeader(headers, CORRELATION_HEADER) ?? readHeader(headers, REQUEST_ID_HEADER);
};

export interface ObservabilityMiddlewareOptions {
  /** Service identifier — slug per `moduleId(value)`. */
  moduleId: string;

  /** Override the default header-based correlation extractor. */
  extractor?: CorrelationExtractor;

  /**
   * If `true` (default), requests without a correlation header get a
   * fresh UUIDv4 generated. If `false`, the request passes through with
   * no correlation context bound — appropriate for downstream services
   * that should propagate but never invent.
   */
  generateIfMissing?: boolean;

  /**
   * Paths that bypass the middleware entirely (exact match). Default:
   * `['/health', '/healthz', '/readiness', '/liveness']`.
   */
  skipPaths?: string[];

  /**
   * Optional logger used for middleware-level diagnostics only — NOT
   * for request access logs, which are the consumer's responsibility.
   */
  logger?: Logger;

  /**
   * Optional tracer override. Defaults to `createTracer({ moduleId })`.
   * Pass an explicit tracer for tests or for sharing a single tracer
   * across multiple middleware instances.
   */
  tracer?: Tracer;
}

/**
 * Hono context shape used by the adapter. Defined locally so this
 * package does not take a runtime dependency on Hono — the adapter
 * accepts any object that quacks like Hono's context.
 */
interface HonoContextLike {
  req: {
    raw: { headers: Headers };
    method: string;
    url: string;
  };
  set(key: string, value: unknown): void;
}

type HonoNextLike = () => Promise<void>;

/**
 * Express request shape used by the adapter. Structural — no runtime
 * import. `path` / `url` / `method` are individually optional so the
 * middleware works against minimal request mocks.
 */
interface ExpressRequestLike {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  path?: string;
}

type ExpressResponseLike = unknown;
type ExpressNextLike = (err?: unknown) => void;

export interface ObservabilityMiddleware {
  hono(c: HonoContextLike, next: HonoNextLike): Promise<void>;
  express(req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNextLike): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  target: string,
): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    const value = headers[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === 'string' && first.length > 0 ? first : undefined;
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function honoHeadersToRecord(headers: Headers): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

interface ResolvedOptions {
  moduleId: ModuleId;
  extractor: CorrelationExtractor;
  generateIfMissing: boolean;
  skipPaths: ReadonlySet<string>;
  logger: Logger | undefined;
  tracer: Tracer;
}

function resolveOptions(options: ObservabilityMiddlewareOptions): ResolvedOptions {
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

  return {
    moduleId: validatedModuleId,
    extractor: options.extractor ?? defaultCorrelationExtractor,
    generateIfMissing: options.generateIfMissing ?? true,
    skipPaths: new Set(options.skipPaths ?? DEFAULT_SKIP_PATHS),
    logger: options.logger,
    tracer: options.tracer ?? createTracer({ moduleId: validatedModuleId }),
  };
}

/**
 * Core extraction + span + context-binding pipeline, framework-agnostic.
 * The caller passes the request's headers, method, path, a setter for
 * stashing the correlation_id back on the framework's request object,
 * and a `runDownstream` callback that invokes the next middleware /
 * handler.
 */
async function handle(
  resolved: ResolvedOptions,
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  setRequestProperty: (correlationId: string) => void,
  runDownstream: () => void | Promise<void>,
): Promise<void> {
  if (resolved.skipPaths.has(path)) {
    await runDownstream();
    return;
  }

  let extracted = resolved.extractor({ headers });
  if (extracted === undefined) {
    if (!resolved.generateIfMissing) {
      await runDownstream();
      return;
    }
    extracted = generateCorrelationId();
  }
  const correlationId = extracted;

  setRequestProperty(correlationId);

  const span = resolved.tracer.startSpan(`${method} ${path}`, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.method': method,
      'http.target': path,
      'cortex.correlation_id': correlationId,
    },
  });

  try {
    await context.with(trace.setSpan(context.active(), span), async () => {
      await withCorrelationContext(correlationId, async () => {
        await runDownstream();
      });
    });
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

// ─────────────────────────────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Build an observability middleware. Returns adapter methods for
 * supported frameworks. Each adapter shares the same extraction + span
 * + context-binding core; pick whichever matches the host service's
 * framework.
 *
 * @throws ObservabilityConfigError — invalid `moduleId`.
 */
export function buildObservabilityMiddleware(
  options: ObservabilityMiddlewareOptions,
): ObservabilityMiddleware {
  const resolved = resolveOptions(options);

  return {
    async hono(c, next) {
      const headers = honoHeadersToRecord(c.req.raw.headers);
      const method = c.req.method;
      const path = new URL(c.req.url).pathname;
      await handle(
        resolved,
        headers,
        method,
        path,
        (correlationId) => {
          c.set('correlationId', correlationId);
        },
        async () => {
          await next();
        },
      );
    },

    async express(req, _res, next) {
      try {
        const method = req.method ?? 'GET';
        const hostHeader = req.headers.host;
        const host =
          typeof hostHeader === 'string' && hostHeader.length > 0 ? hostHeader : 'localhost';
        const path = req.path ?? new URL(req.url ?? '/', `http://${host}`).pathname;

        await handle(
          resolved,
          req.headers,
          method,
          path,
          (correlationId) => {
            const reqWithCorr = req as ExpressRequestLike & { correlationId?: string };
            reqWithCorr.correlationId = correlationId;
          },
          () => {
            next();
            return Promise.resolve();
          },
        );
      } catch (err) {
        next(err);
      }
    },
  };
}

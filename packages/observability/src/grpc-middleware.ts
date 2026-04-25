/**
 * gRPC server interceptor for @cortex/observability.
 *
 * Wraps a gRPC handler invocation in the same observability context the
 * HTTP middleware establishes: extract or generate a `correlation_id`,
 * open a SERVER-kind OTel span, run the handler inside both the
 * correlation_id AsyncLocalStorage AND the OTel span context. Logs and
 * metrics emitted by the handler automatically inherit
 * `correlation_id`, `trace_id`, `span_id`.
 *
 * Framework-agnostic — accepts any object that quacks like a `Metadata`
 * + `method` from `@grpc/grpc-js`. No runtime import of grpc-js.
 *
 * Usage shape (typical, with @grpc/grpc-js):
 *
 *     const interceptor = buildGrpcInterceptor({ moduleId: 'tenants' });
 *
 *     server.addService(TenantsService, {
 *       Create: (call, callback) => {
 *         interceptor.wrap(
 *           { metadata: call.metadata, method: '/cortex...Tenants/Create' },
 *           async () => {
 *             const result = await createTenantHandler(call.request);
 *             callback(null, result);
 *           },
 *         ).catch((err) => callback(err));
 *       },
 *     });
 *
 * For streaming RPCs the same wrap pattern works — the handler receives
 * the call object as args, and `span.end()` fires when the wrapped
 * promise resolves (after the stream closes, if the consumer chains
 * resolution to stream-end).
 *
 * Like the HTTP middleware, this does NOT log requests itself — that's
 * the consumer's job using the logger, which auto-inherits the bound
 * correlation_id.
 */

import { context, SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { ObservabilityConfigError, ObservabilityValidationError } from './errors.js';
import { generateCorrelationId, withCorrelationContext } from './correlation-context.js';
import { createTracer } from './tracer.js';
import { moduleId, type ModuleId } from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const GRPC_CORRELATION_METADATA_KEY = 'x-correlation-id';
const GRPC_REQUEST_ID_METADATA_KEY = 'x-request-id';

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Subset of `@grpc/grpc-js` Metadata sufficient for correlation lookup.
 * Real Metadata.get() returns `MetadataValue[]` (where `MetadataValue =
 * string | Buffer`); we accept the simpler `string | string[] |
 * undefined` shape since correlation IDs are always strings.
 */
export interface GrpcMetadataLike {
  get(key: string): string[] | string | undefined;
}

/**
 * Subset of a gRPC call-context. `method` is the full RPC path, e.g.
 * `/cortex.foundation.v1.Tenants/Create`.
 */
export interface GrpcCallContextLike {
  metadata: GrpcMetadataLike;
  method: string;
}

export interface GrpcInterceptorOptions {
  /** Service identifier — slug per `moduleId(value)`. */
  moduleId: string;

  /**
   * If `true` (default), calls without a correlation metadata entry get
   * a fresh UUIDv4. If `false`, the call passes through with no
   * correlation context bound.
   */
  generateIfMissing?: boolean;

  /**
   * Optional tracer override. Defaults to `createTracer({ moduleId })`.
   */
  tracer?: Tracer;
}

export interface GrpcInterceptor {
  wrap<TArgs extends unknown[], TResult>(
    callContext: GrpcCallContextLike,
    handler: (...args: TArgs) => Promise<TResult>,
    ...args: TArgs
  ): Promise<TResult>;
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

function extractCorrelationFromMetadata(metadata: GrpcMetadataLike): string | undefined {
  for (const key of [GRPC_CORRELATION_METADATA_KEY, GRPC_REQUEST_ID_METADATA_KEY]) {
    const raw = metadata.get(key);
    if (raw === undefined) continue;
    if (typeof raw === 'string') {
      if (raw.length > 0) return raw;
      continue;
    }
    if (Array.isArray(raw) && raw.length > 0) {
      const first = raw[0];
      if (typeof first === 'string' && first.length > 0) return first;
    }
  }
  return undefined;
}

/**
 * Parse the service portion of `/<service>/<method>`. Falls back to the
 * full path string when the method does not match the canonical shape.
 */
function extractService(method: string): string {
  if (!method.startsWith('/')) return method;
  const secondSlash = method.indexOf('/', 1);
  if (secondSlash === -1) return method.slice(1);
  return method.slice(1, secondSlash);
}

/**
 * Parse the method portion of `/<service>/<method>`. Falls back to the
 * full path string when the method does not match the canonical shape.
 */
function extractMethodName(method: string): string {
  if (!method.startsWith('/')) return method;
  const secondSlash = method.indexOf('/', 1);
  if (secondSlash === -1) return method;
  return method.slice(secondSlash + 1);
}

interface ResolvedOptions {
  moduleId: ModuleId;
  generateIfMissing: boolean;
  tracer: Tracer;
}

function resolveOptions(options: GrpcInterceptorOptions): ResolvedOptions {
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
    generateIfMissing: options.generateIfMissing ?? true,
    tracer: options.tracer ?? createTracer({ moduleId: validatedModuleId }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a gRPC server interceptor. Returns an object with a single
 * `wrap` method; consumers call it inside their RPC handler dispatch.
 *
 * @throws ObservabilityConfigError — invalid `moduleId`.
 */
export function buildGrpcInterceptor(options: GrpcInterceptorOptions): GrpcInterceptor {
  const resolved = resolveOptions(options);

  return {
    async wrap<TArgs extends unknown[], TResult>(
      callContext: GrpcCallContextLike,
      handler: (...args: TArgs) => Promise<TResult>,
      ...args: TArgs
    ): Promise<TResult> {
      let extracted = extractCorrelationFromMetadata(callContext.metadata);
      if (extracted === undefined) {
        if (!resolved.generateIfMissing) {
          return handler(...args);
        }
        extracted = generateCorrelationId();
      }
      const correlationId = extracted;

      const span = resolved.tracer.startSpan(callContext.method, {
        kind: SpanKind.SERVER,
        attributes: {
          'rpc.system': 'grpc',
          'rpc.service': extractService(callContext.method),
          'rpc.method': extractMethodName(callContext.method),
          'cortex.correlation_id': correlationId,
        },
      });

      try {
        return await context.with(trace.setSpan(context.active(), span), async () => {
          return await withCorrelationContext(correlationId, async () => {
            return await handler(...args);
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
    },
  };
}

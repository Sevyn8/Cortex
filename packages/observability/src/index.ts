/**
 * Public barrel for `@cortex/observability`.
 *
 * Test-only utilities (e.g., `LogCapture`) live behind the
 * `@cortex/observability/test-utils` subpath export — they are NOT
 * re-exported here to keep production imports lean.
 */

// Errors + envelope
export {
  ObservabilityError,
  ObservabilityConfigError,
  ObservabilityContextError,
  ObservabilityExportError,
  ObservabilityValidationError,
  toErrorEnvelope,
  type ErrorEnvelope,
  type ObservabilityErrorCode,
} from './errors.js';

// Types + branded module id
export {
  moduleId,
  type ModuleId,
  type Severity,
  type StandardLogFields,
  type StandardMetricLabels,
  type ContextProvider,
} from './types.js';

// Context provider
export { defaultContextProvider, stubContextProvider } from './context-provider.js';

// Correlation context
export {
  generateCorrelationId,
  getCorrelationId,
  withCorrelationContext,
  type CorrelationContextSnapshot,
} from './correlation-context.js';

// Logger
export { createLogger, type Logger, type CreateLoggerOptions } from './logger.js';

// Redaction
export { buildRedactionConfig, DEFAULT_REDACTION_PATHS, REDACTION_CENSOR } from './redaction.js';

// Tracer
export {
  createTracer,
  getCurrentSpanId,
  getCurrentTraceId,
  withSpan,
  type CreateTracerOptions,
} from './tracer.js';

// Metrics
export {
  createMetricsRegistry,
  type MetricsRegistry,
  type CreateMetricsRegistryOptions,
} from './metrics.js';

// SDK lifecycle
export {
  initObservabilitySdk,
  shutdownObservabilitySdk,
  type InitObservabilitySdkOptions,
} from './sdk.js';

// HTTP middleware
export {
  buildObservabilityMiddleware,
  defaultCorrelationExtractor,
  type CorrelationExtractor,
  type ObservabilityMiddleware,
  type ObservabilityMiddlewareOptions,
} from './http-middleware.js';

// gRPC interceptor
export {
  buildGrpcInterceptor,
  type GrpcCallContextLike,
  type GrpcInterceptor,
  type GrpcInterceptorOptions,
  type GrpcMetadataLike,
} from './grpc-middleware.js';

// Pub/Sub wrapper
export {
  buildPubSubWrapper,
  type PubSubMessageHandler,
  type PubSubMessageLike,
  type PubSubWrapperOptions,
} from './pubsub-wrapper.js';

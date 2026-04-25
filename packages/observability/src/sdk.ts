/**
 * OTel SDK lifecycle for Cortex services.
 *
 * The SDK is process-global. `initObservabilitySdk` is the canonical
 * entry point — call once at service startup, before any HTTP / gRPC
 * server starts listening, so auto-instrumentation can hook into the
 * frameworks before they bind sockets.
 *
 * Auto-instrumentations (HTTP, gRPC, Postgres, Redis, etc.) are enabled
 * by default and provide spans without per-call boilerplate.
 *
 * Per ADR-OBS-001 §Decision 1 (OTel-vendor-neutral, OTLP transport).
 */

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ObservabilityConfigError, ObservabilityValidationError } from './errors.js';
import { moduleId, type ModuleId } from './types.js';

const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318';
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface InitObservabilitySdkOptions {
  /**
   * Service identifier — slug per `moduleId(value)`. Becomes the OTel
   * resource's `service.name` attribute.
   */
  moduleId: string;

  /**
   * OTLP HTTP base endpoint. Trace export hits `${endpoint}/v1/traces`,
   * metrics hit `${endpoint}/v1/metrics`.
   *
   * Defaults to `process.env.OTEL_EXPORTER_OTLP_ENDPOINT` if set, else
   * `http://localhost:4318` (OTel Collector default port).
   */
  otlpEndpoint?: string;

  /**
   * Headers attached to every OTLP export request — useful for
   * authenticated collectors (e.g., a Cloud Run sidecar requiring
   * `Authorization: Bearer ...`).
   */
  otlpHeaders?: Record<string, string>;

  /**
   * Enable Node auto-instrumentations (HTTP / gRPC / pg / Redis / fs /
   * dns / etc.). Default: `true`. Disable for tests or low-traffic
   * services where the instrumentation overhead is not worth it.
   */
  enableAutoInstrumentations?: boolean;

  /**
   * Metric export cadence. Default 60s. Lower in dev for faster
   * feedback; higher in prod to reduce egress cost.
   */
  metricExportIntervalMs?: number;
}

/**
 * Construct (do not start) a configured `NodeSDK`. Caller is responsible
 * for `sdk.start()` and graceful `sdk.shutdown()` on SIGTERM.
 *
 * @throws ObservabilityConfigError — invalid `moduleId`.
 */
export function initObservabilitySdk(options: InitObservabilitySdkOptions): NodeSDK {
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

  const endpoint =
    options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT;
  const headers = options.otlpHeaders;
  const enableAuto = options.enableAutoInstrumentations ?? true;
  const exportIntervalMillis = options.metricExportIntervalMs ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS;

  // `service.namespace` is in `@opentelemetry/semantic-conventions`'s
  // experimental subpath; using the literal here keeps the import clean
  // and the value is part of the OTel spec semantic conventions.
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: validatedModuleId,
    'service.namespace': 'cortex',
  });

  const traceExporter = new OTLPTraceExporter(
    headers === undefined
      ? { url: `${endpoint}/v1/traces` }
      : { url: `${endpoint}/v1/traces`, headers },
  );

  const metricExporter = new OTLPMetricExporter(
    headers === undefined
      ? { url: `${endpoint}/v1/metrics` }
      : { url: `${endpoint}/v1/metrics`, headers },
  );

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis,
  });

  return new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: enableAuto ? [getNodeAutoInstrumentations()] : [],
  });
}

/**
 * Graceful shutdown wrapper. Times out after 5 seconds and logs to
 * stderr if the underlying SDK shutdown didn't complete in time. We use
 * `console.error` here intentionally — the observability layer cannot
 * observably-log its own shutdown failure.
 */
export async function shutdownObservabilitySdk(sdk: NodeSDK): Promise<void> {
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });
  const shutdown = sdk.shutdown().then(() => 'ok' as const);
  const result = await Promise.race([shutdown, timeout]);
  if (result === 'timeout') {
    console.error(
      `[OBSERVABILITY-SDK] shutdown timed out after ${String(DEFAULT_SHUTDOWN_TIMEOUT_MS)}ms`,
    );
  }
}

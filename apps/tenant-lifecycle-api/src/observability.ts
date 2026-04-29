/**
 * D.1 cold-start instrumentation per SD3.
 *
 * Two markers are captured:
 *   - PROCESS_START_HR: monotonic timestamp at module evaluation
 *     (earliest in-process moment we can mark; container pull +
 *     image decompress happen before this, captured by Cloud Run's
 *     `instance_startup_latencies` instead).
 *   - first-request-handled: stamped by the cold-start middleware
 *     on the first request per instance; emits an OTel span event
 *     + a histogram metric + a structured log line.
 *
 * The 30-burst measurement script (`scripts/cold-start-burst.sh`)
 * pulls the histogram via OTLP → Cloud Trace and cross-checks
 * against `instance_startup_latencies`. SD3 expects the two to agree
 * within 20 %; > 20 % divergence is treated as a methodology problem
 * before a framework problem.
 */
import { performance } from 'node:perf_hooks';
import {
  composeContextProviders,
  createLogger,
  createMetricsRegistry,
  createTracer,
  defaultContextProvider,
  initObservabilitySdk,
  type Logger,
  type MetricsRegistry,
  shutdownObservabilitySdk,
} from '@cortex/observability';
import { tenantContextProvider } from '@cortex/tenant-context';
import type { Tracer } from '@opentelemetry/api';

const MODULE_ID = 'tenant-lifecycle-api';

// Captured at module evaluation. Monotonic clock; safe to subtract.
export const PROCESS_START_HR = performance.now();

export interface Telemetry {
  logger: Logger;
  tracer: Tracer;
  metrics: MetricsRegistry;
  /** Pre-built histogram for cold-start observations (ms). */
  coldStartMs: ReturnType<MetricsRegistry['histogram']>;
  /** Records cold-start once on the first call; subsequent calls no-op. */
  recordColdStartOnce: () => void;
  /** Lifecycle: shutdown the OTel SDK. Call from SIGTERM handler. */
  shutdown: () => Promise<void>;
}

export function initTelemetry(): Telemetry {
  const sdk = initObservabilitySdk({ moduleId: MODULE_ID });
  sdk.start();

  const logger = createLogger({
    moduleId: MODULE_ID,
    contextProvider: composeContextProviders(defaultContextProvider, tenantContextProvider),
  });
  const tracer = createTracer({ moduleId: MODULE_ID });
  const metrics = createMetricsRegistry({ moduleId: MODULE_ID });

  const coldStartMs = metrics.histogram('cold_start_ms', {
    description:
      'D.1 SD3 cold-start: process spawn (perf_hooks performance.now()=0) → first request handled.',
    unit: 'ms',
  });

  let recorded = false;
  const recordColdStartOnce = (): void => {
    if (recorded) return;
    recorded = true;
    const elapsed = performance.now() - PROCESS_START_HR;
    coldStartMs.observe({ phase: 'first_request' }, elapsed);
    logger.info(
      {
        cold_start_ms: elapsed,
        revision: process.env.K_REVISION ?? 'unknown',
        marker: 'd1-cold-start',
      },
      'D.1 cold-start observation recorded',
    );
  };

  return {
    logger,
    tracer,
    metrics,
    coldStartMs,
    recordColdStartOnce,
    shutdown: async () => {
      await shutdownObservabilitySdk(sdk);
    },
  };
}

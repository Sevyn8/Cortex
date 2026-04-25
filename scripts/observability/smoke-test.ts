/**
 * @cortex/observability smoke test — exercises the full pipeline (logger,
 * tracer, meter, OTLP exporter) end-to-end, then prints Cloud Logging /
 * Cloud Trace / Cloud Monitoring URLs the operator can open to verify the
 * data landed.
 *
 * Manual / on-demand only — NOT wired into CI. Each run emits a small
 * burst of telemetry (~10 logs, 2 spans, 3 metric points). Cost is well
 * under GCP free-tier limits per run, but automating the loop would burn
 * export quota and Cloud Logging ingestion budget.
 *
 * Prerequisites:
 *   - GCP_PROJECT_ID env var (defaults to `sevyn8-cortex-dev`)
 *   - OTEL_EXPORTER_OTLP_ENDPOINT pointing at a collector that forwards
 *     to GCP. Typical setup: an OTel Collector sidecar running locally
 *     on port 4318 with the GCP exporter configured. If unset, the SDK
 *     falls back to `http://localhost:4318` (the OTel Collector default
 *     port) — start the collector first or the export silently no-ops.
 *   - `gcloud auth application-default login` so the collector / GCP
 *     exporter can authenticate.
 *
 * Run:
 *   pnpm --filter @cortex/observability-smoke smoke
 *   # or, from the repo root:
 *   pnpm observability:smoke
 */

/* eslint-disable no-console -- CLI tool whose entire purpose is operator-facing stdout */

import { performance } from 'node:perf_hooks';
import {
  createLogger,
  createMetricsRegistry,
  createTracer,
  generateCorrelationId,
  getCurrentTraceId,
  initObservabilitySdk,
  shutdownObservabilitySdk,
  withCorrelationContext,
  withSpan,
} from '@cortex/observability';

const MODULE_ID = 'smoke-test';

function buildVerificationUrls(args: {
  project: string;
  correlationId: string;
  traceId: string | undefined;
}): { logging: string; trace: string | undefined; monitoring: string } {
  const project = encodeURIComponent(args.project);
  const loggingFilter = encodeURIComponent(
    `jsonPayload.module_id="${MODULE_ID}" jsonPayload.correlation_id="${args.correlationId}"`,
  );
  const logging = `https://console.cloud.google.com/logs/query;query=${loggingFilter}?project=${project}`;
  const trace =
    args.traceId !== undefined
      ? `https://console.cloud.google.com/traces/list?tid=${encodeURIComponent(args.traceId)}&project=${project}`
      : undefined;
  const monitoring = `https://console.cloud.google.com/monitoring/metrics-explorer?project=${project}`;

  return { logging, trace, monitoring };
}

async function main(): Promise<void> {
  const correlationId = generateCorrelationId();
  const project = process.env.GCP_PROJECT_ID ?? 'sevyn8-cortex-dev';
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  console.log(`[smoke] correlation_id: ${correlationId}`);
  console.log(`[smoke] project:        ${project}`);
  console.log(`[smoke] otlp endpoint:  ${otlpEndpoint}`);

  const sdk = initObservabilitySdk({ moduleId: MODULE_ID });
  sdk.start();

  let parentTraceId: string | undefined;

  try {
    const startedAt = performance.now();

    await withCorrelationContext(correlationId, async () => {
      const logger = createLogger({ moduleId: MODULE_ID });
      const tracer = createTracer({ moduleId: MODULE_ID });
      const registry = createMetricsRegistry({ moduleId: MODULE_ID });

      // ── Logs at every severity ────────────────────────────────────
      logger.debug({ marker: 'smoke-debug' }, 'smoke debug');
      logger.info({ marker: 'smoke-info' }, 'smoke info');
      logger.warn({ marker: 'smoke-warn' }, 'smoke warn');
      logger.error({ marker: 'smoke-error' }, 'smoke error');

      // ── Trace: parent + child spans ──────────────────────────────
      await withSpan(tracer, 'smoke-test/parent', async () => {
        parentTraceId = getCurrentTraceId();
        await withSpan(tracer, 'smoke-test/child', async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        });
      });

      // ── Metrics: counter, histogram, gauge ───────────────────────
      const runs = registry.counter('smoke_test.runs_total', {
        description: 'Total smoke-test runs',
      });
      runs.inc({ outcome: 'ok' });

      const duration = registry.histogram('smoke_test.duration_ms', {
        description: 'Smoke-test main-block elapsed time',
        unit: 'ms',
      });
      duration.observe({ phase: 'main' }, performance.now() - startedAt);

      const lastRun = registry.gauge('smoke_test.last_run_timestamp_ms', {
        description: 'Wall-clock timestamp of the most recent smoke-test run',
        unit: 'ms',
      });
      lastRun.set({}, Date.now());
    });

    const urls = buildVerificationUrls({ project, correlationId, traceId: parentTraceId });

    console.log('');
    console.log('=== Verification URLs ===');
    console.log(`Cloud Logging:    ${urls.logging}`);
    if (urls.trace !== undefined) {
      console.log(`Cloud Trace:      ${urls.trace}`);
    } else {
      console.log('Cloud Trace:      (no parent trace_id captured — investigate)');
    }
    console.log(`Cloud Monitoring: ${urls.monitoring}`);
    console.log('');
    console.log(
      'Note: metric export interval defaults to 60s. Allow ~1 min for counter/histogram/gauge points to appear in Monitoring.',
    );
  } finally {
    await shutdownObservabilitySdk(sdk);
  }
}

main().catch((err: unknown) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});

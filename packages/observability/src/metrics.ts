/**
 * prom-client-style metrics API surface backed by the OTel meter.
 *
 * Per ADR-OBS-001 §Decision 1: developer ergonomics of prom-client
 * (Counter/Histogram/Gauge with `inc()` / `observe()` / `set()`)
 * combined with OTel's transport (OTLP export to Cloud Monitoring on
 * Cloud Run). The OTel API's synchronous `Gauge` (added in
 * `@opentelemetry/api@1.9`) lets us back the prom-style `set()` cleanly
 * without an UpDownCounter workaround.
 *
 * Cardinality reminder: `tenant_id` labels are high-cardinality at
 * scale; future-roadmap §1.6 tracks the parallel infrastructure
 * concern. Phase 1 has a single tenant — accepted cost.
 */

import { metrics, type MetricOptions } from '@opentelemetry/api';
import { ObservabilityConfigError, ObservabilityValidationError } from './errors.js';
import { moduleId } from './types.js';

const METRICS_VERSION = '0.0.0';

export interface CreateMetricsRegistryOptions {
  /**
   * Service identifier — slug per `moduleId(value)`. Becomes the
   * meter's instrumentation library name.
   */
  moduleId: string;
}

export interface CounterOptions {
  description?: string;
  unit?: string;
}

export interface HistogramOptions {
  description?: string;
  unit?: string;
  /**
   * Explicit bucket boundaries hint passed to the OTel histogram via
   * `advice.explicitBucketBoundaries` (experimental). SDKs may ignore
   * the hint; tune via SDK view config when precise control matters.
   */
  boundaries?: number[];
}

export interface GaugeOptions {
  description?: string;
  unit?: string;
}

export interface Counter {
  inc(labels?: Record<string, string>, value?: number): void;
}

export interface Histogram {
  observe(labels: Record<string, string>, value: number): void;
}

export interface Gauge {
  set(labels: Record<string, string>, value: number): void;
}

export interface MetricsRegistry {
  counter(name: string, options?: CounterOptions): Counter;
  histogram(name: string, options?: HistogramOptions): Histogram;
  gauge(name: string, options?: GaugeOptions): Gauge;
}

/**
 * Construct a metrics registry. The OTel meter registry caches by
 * `(name, version)`, so multiple calls with the same `moduleId` reuse
 * the underlying meter.
 *
 * @throws ObservabilityConfigError — invalid `moduleId`.
 */
export function createMetricsRegistry(options: CreateMetricsRegistryOptions): MetricsRegistry {
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

  const meter = metrics.getMeter(validatedModuleId, METRICS_VERSION);

  return {
    counter(name, opts) {
      const otelCounter = meter.createCounter(name, buildBaseOptions(opts));
      return {
        inc(labels, value = 1) {
          otelCounter.add(value, labels ?? {});
        },
      };
    },
    histogram(name, opts) {
      const metricOptions = buildBaseOptions(opts);
      if (opts?.boundaries !== undefined) {
        metricOptions.advice = { explicitBucketBoundaries: opts.boundaries };
      }
      const otelHistogram = meter.createHistogram(name, metricOptions);
      return {
        observe(labels, value) {
          otelHistogram.record(value, labels);
        },
      };
    },
    gauge(name, opts) {
      const otelGauge = meter.createGauge(name, buildBaseOptions(opts));
      return {
        set(labels, value) {
          otelGauge.record(value, labels);
        },
      };
    },
  };
}

/**
 * Build a `MetricOptions` object that only carries the keys the caller
 * actually supplied. Required because `tsconfig.base.json` enables
 * `exactOptionalPropertyTypes`, so passing `{ description: undefined }`
 * is rejected against `MetricOptions['description']: string | undefined?`.
 */
function buildBaseOptions(
  opts: { description?: string; unit?: string } | undefined,
): MetricOptions {
  const out: MetricOptions = {};
  if (opts?.description !== undefined) out.description = opts.description;
  if (opts?.unit !== undefined) out.unit = opts.unit;
  return out;
}

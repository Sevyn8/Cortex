/**
 * Shared types for `@cortex/observability`.
 *
 * Re-exports the `ContextProvider` interface so consumers have a single
 * import surface for "everything I need to type the package."
 */

import { ObservabilityValidationError } from './errors.js';

/**
 * Cloud Logging severity levels. Pino's default labels
 * (trace/debug/info/warn/error/fatal) get mapped to these via the
 * formatter defined in `logger.ts` (sub-phase 2.3) so JSON written to
 * stdout is parsed natively by Cloud Logging without an intermediate
 * log-router transformation.
 *
 * Reference:
 * https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
 */
export type Severity =
  | 'DEBUG'
  | 'INFO'
  | 'NOTICE'
  | 'WARNING'
  | 'ERROR'
  | 'CRITICAL'
  | 'ALERT'
  | 'EMERGENCY';

/**
 * Branded `ModuleId` — every service supplies one when constructing its
 * logger / tracer / metrics registry. Format: lowercase slug,
 * `^[a-z][a-z0-9-]*[a-z0-9]$`, length 2..64. Examples:
 * `cortex-foundation`, `cortex-tenant-lifecycle`.
 *
 * Branding ensures a raw `string` cannot be accidentally passed where a
 * validated `ModuleId` is required — callers must funnel through the
 * `moduleId(value)` validator.
 */
export type ModuleId = string & { readonly __brand: 'ModuleId' };

const MODULE_ID_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const MODULE_ID_MIN = 2;
const MODULE_ID_MAX = 64;

/**
 * Validate + brand a `moduleId`. Throws `ObservabilityValidationError`
 * if the value doesn't match the slug regex or is outside the
 * 2..64-char range.
 */
export function moduleId(value: string): ModuleId {
  if (typeof value !== 'string' || value.length < MODULE_ID_MIN || value.length > MODULE_ID_MAX) {
    throw new ObservabilityValidationError(
      `moduleId must be ${MODULE_ID_MIN}..${MODULE_ID_MAX} characters; got length ${String(value?.length ?? 0)}`,
    );
  }
  if (!MODULE_ID_REGEX.test(value)) {
    throw new ObservabilityValidationError(
      `moduleId must match /^[a-z][a-z0-9-]*[a-z0-9]$/ (lowercase slug, no leading/trailing hyphen); got "${value}"`,
    );
  }
  return value as ModuleId;
}

/**
 * Standard log fields injected on every log line by the logger built in
 * sub-phase 2.3. Each optional field is included when its corresponding
 * `ContextProvider` getter returns a value; absent fields are omitted
 * (not emitted as `null`) to keep Cloud Logging entries clean.
 *
 * Per ADR-OBS-001 §Decision 2.
 */
export interface StandardLogFields {
  module_id: string;
  tenant_id?: string;
  user_id?: string;
  correlation_id?: string;
  trace_id?: string;
  span_id?: string;
}

/**
 * Standard metric labels attached to every metric by the metrics
 * registry built in sub-phase 2.6.
 *
 * Cardinality note: `tenant_id` is high-cardinality at scale. Phase 1
 * has a single tenant so the cost is negligible. Multi-tenant traffic
 * inflection should trigger a roadmap revisit (cf. future-roadmap §1.6
 * for the analogous infrastructure-side concern).
 */
export interface StandardMetricLabels {
  module_id: string;
  tenant_id?: string;
}

export type { ContextProvider } from './context-provider.js';

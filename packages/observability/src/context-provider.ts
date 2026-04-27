/**
 * `ContextProvider` is the seam through which the observability library
 * pulls per-request context (tenant id, user id, correlation id, OTel
 * trace + span ids) into every emitted log line, metric label, and span
 * attribute.
 *
 * Per ADR-OBS-001 §Decision 2:
 * - Tenant id is NOT auto-resolved here. observability is a leaf
 *   primitive; tenant binding is a higher-level concern owned by
 *   `@cortex/tenant-context`. Apps that want `tenant_id` in log fields
 *   compose `tenantContextProvider` from `@cortex/tenant-context`
 *   alongside `defaultContextProvider` via `composeContextProviders`
 *   at startup:
 *
 *     import { defaultContextProvider, composeContextProviders }
 *       from '@cortex/observability';
 *     import { tenantContextProvider } from '@cortex/tenant-context';
 *
 *     const provider = composeContextProviders(
 *       defaultContextProvider,
 *       tenantContextProvider,
 *     );
 *     const logger = createLogger({ contextProvider: provider });
 *
 *   Libraries do NOT compose; they accept whatever `ContextProvider`
 *   their caller supplies via `createLogger` options. See roadmap
 *   §4.13 (resolved) for the cycle-decoupling rationale.
 * - User id comes from AC01 (deferred; stub returns `undefined`).
 * - Correlation id comes from observability's own request-scope store,
 *   set by the HTTP middleware.
 * - Trace + span ids come from the OTel context.
 *
 * Every getter MUST be cheap — they are called on every log emission,
 * every metric increment, and every span start. No DB lookups, no
 * network calls.
 */

import { getCorrelationId } from './correlation-context.js';
import { getCurrentSpanId, getCurrentTraceId } from './tracer.js';

export interface ContextProvider {
  getTenantId(): string | undefined;
  getUserId(): string | undefined;
  getCorrelationId(): string | undefined;
  getTraceId(): string | undefined;
  getSpanId(): string | undefined;
}

/**
 * No-op provider. Every getter returns `undefined`. Used as the default
 * when a consumer does not supply a `ContextProvider`, and in tests
 * where context coupling would add noise.
 *
 * Frozen to make accidental mutation a TypeError at runtime.
 */
export const stubContextProvider: Readonly<ContextProvider> = Object.freeze({
  getTenantId: () => undefined,
  getUserId: () => undefined,
  getCorrelationId: () => undefined,
  getTraceId: () => undefined,
  getSpanId: () => undefined,
});

/**
 * Production provider. Wires the observability-internal getters
 * (correlation id, trace id, span id) — does NOT auto-resolve tenant
 * id; see the file header for the composition pattern. Apps wanting
 * tenant id in log fields compose `tenantContextProvider` from
 * `@cortex/tenant-context` via `composeContextProviders`.
 */
export const defaultContextProvider: ContextProvider = {
  getTenantId: () => undefined,
  // TODO(AC01): wire from auth context store once AC01 ships its
  // request-scope user store.
  getUserId: () => undefined,
  getCorrelationId,
  getTraceId: getCurrentTraceId,
  getSpanId: getCurrentSpanId,
};

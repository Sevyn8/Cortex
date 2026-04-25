/**
 * `ContextProvider` is the seam through which the observability library
 * pulls per-request context (tenant id, user id, correlation id, OTel
 * trace + span ids) into every emitted log line, metric label, and span
 * attribute.
 *
 * Per ADR-OBS-001 §Decision 2:
 * - Tenant id comes from F01's async-local store (`@cortex/tenant-context`).
 * - User id comes from AC01 (deferred; stub returns `undefined`).
 * - Correlation id comes from observability's own request-scope store,
 *   set by the HTTP middleware (lands in sub-phase 2.5).
 * - Trace + span ids come from the OTel context (lands in sub-phase 2.4).
 *
 * Every getter MUST be cheap — they are called on every log emission,
 * every metric increment, and every span start. No DB lookups, no
 * network calls.
 */

import { getTenantId } from '@cortex/tenant-context';
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
 * Production provider. Wires `getTenantId` directly to
 * `@cortex/tenant-context`. The remaining getters are placeholders
 * pending later sub-phases / phases — see the TODO markers below. When
 * those wiring points land, this implementation gets updated; consumers
 * see no API surface change.
 */
export const defaultContextProvider: ContextProvider = {
  getTenantId,
  // TODO(AC01): wire from auth context store once AC01 ships its
  // request-scope user store.
  getUserId: () => undefined,
  getCorrelationId,
  getTraceId: getCurrentTraceId,
  getSpanId: getCurrentSpanId,
};

/**
 * Composes multiple `ContextProvider` partials into a single
 * `ContextProvider`.
 *
 * For each method (`getTenantId`, `getUserId`, `getCorrelationId`,
 * `getTraceId`, `getSpanId`), the composed provider invokes each input
 * provider in order and returns the first non-`undefined` result. If
 * all return `undefined` or a provider doesn't define the method, the
 * composed method returns `undefined`.
 *
 * This is the pattern apps use to combine the default observability
 * provider with the tenant-context provider:
 *
 *   const provider = composeContextProviders(
 *     defaultContextProvider,    // correlation, trace, span, user (AC01)
 *     tenantContextProvider,     // tenant_id from async-local
 *   );
 *
 * Order matters: providers earlier in the args list win. Typically:
 * defaults first, then domain-specific overlays.
 *
 * Pure function. No state. No side effects. Per roadmap §4.13
 * (resolved): observability is a leaf primitive; tenant-id binding
 * is a higher-level concern owned by `@cortex/tenant-context`.
 */

import type { ContextProvider } from './types.js';

type ContextProviderInput = ContextProvider | Partial<ContextProvider>;

export function composeContextProviders(
  ...providers: readonly ContextProviderInput[]
): ContextProvider {
  return {
    getTenantId: () => firstDefined(providers, 'getTenantId'),
    getUserId: () => firstDefined(providers, 'getUserId'),
    getCorrelationId: () => firstDefined(providers, 'getCorrelationId'),
    getTraceId: () => firstDefined(providers, 'getTraceId'),
    getSpanId: () => firstDefined(providers, 'getSpanId'),
  };
}

function firstDefined<K extends keyof ContextProvider>(
  providers: readonly ContextProviderInput[],
  key: K,
): string | undefined {
  for (const provider of providers) {
    const fn = provider[key];
    if (fn !== undefined) {
      const value = fn();
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

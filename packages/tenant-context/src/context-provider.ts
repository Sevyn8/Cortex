/**
 * Partial `ContextProvider` exposing tenant-id binding to log fields.
 *
 * Apps compose this with `@cortex/observability`'s
 * `defaultContextProvider` via `composeContextProviders` to get
 * `tenant_id` auto-injected into log fields when an async-local
 * tenant context is bound:
 *
 *   import { defaultContextProvider, composeContextProviders }
 *     from '@cortex/observability';
 *   import { tenantContextProvider } from '@cortex/tenant-context';
 *
 *   const provider = composeContextProviders(
 *     defaultContextProvider,
 *     tenantContextProvider,
 *   );
 *
 * Lives in `@cortex/tenant-context` (not `@cortex/observability`) per
 * the roadmap §4.13 decoupling: observability is a leaf primitive that
 * does NOT know about tenant binding; tenant-context owns the
 * integration.
 *
 * The export's type is intentionally inlined (`{ getTenantId: () =>
 * string | undefined }`) rather than `Partial<ContextProvider>` from
 * `@cortex/observability`. This keeps `@cortex/tenant-context` free of
 * any observability dep — even type-only — and preserves the §4.13
 * acyclic invariant. Structural compatibility with `ContextProvider`
 * is the contract; `composeContextProviders` enforces it at the call
 * site.
 *
 * Pure read-side adapter — wraps the existing `getTenantId` from
 * `./context.js`. No new state; no new behavior.
 */

import { getTenantId } from './context.js';

export const tenantContextProvider: { getTenantId: () => string | undefined } = {
  getTenantId: () => getTenantId(),
};

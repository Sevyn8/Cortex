/**
 * Per-tier default quota configuration helper for `@cortex/quotas`.
 *
 * Phase 1 returns hardcoded values from `DEFAULT_TIER_QUOTAS` (planning
 * Decision 7). F02 will swap this implementation to consult
 * `tenant_config_version.config_json.quotas[resource_class]` with
 * fallback to these defaults. Same Slice B → F02 pattern as
 * `@cortex/secrets.getKeyForTenant` (ADR-INFRA-007).
 *
 * The defaults are TUNABLE baselines, not load-derived truths. Callers
 * seeing 429s on legitimate traffic should adjust via the F02 swap
 * path, NOT by widening these constants. Planning doc Decision 7
 * captures the "defaults exist as a floor, not a target" framing.
 */

import { DEFAULT_TIER_QUOTAS, type QuotaTier, type ResourceClass } from './types.js';

/**
 * Returns the default quota limit for a `(tier, resourceClass)` pair.
 *
 * Phase 1 stub: returns the `DEFAULT_TIER_QUOTAS` lookup. F02 will
 * accept an optional `tenantId`, query `tenant_config_version`, and
 * fall back to `DEFAULT_TIER_QUOTAS` if no per-tenant override exists.
 *
 * @param tier - Tenant's commercial tier (`'STANDARD' | 'ENTERPRISE'`)
 * @param resourceClass - The quota dimension being checked
 * @returns BigInt quota limit
 */
export function getQuotaConfig(tier: QuotaTier, resourceClass: ResourceClass): bigint {
  return DEFAULT_TIER_QUOTAS[tier][resourceClass];
}

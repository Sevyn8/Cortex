/**
 * Per-tier + per-tenant quota configuration helper for `@cortex/quotas`.
 *
 * F02 Slice A swap (sub-phase 5.3): when `ctx` supplies `tenantId` AND
 * `db`, queries the tenant's latest `tenant_config_version` row and
 * reads `config_json.quotas[resource_class]` for a per-tenant override.
 * Falls back to `DEFAULT_TIER_QUOTAS[tier]` when:
 *   - `ctx` is undefined (legacy callers preserve the pure-default
 *     lookup behavior).
 *   - `tenant_config_version` has no row for the tenant (newly
 *     provisioned tenants without `initialConfig`).
 *   - `config_json.quotas` is absent or `config_json.quotas[resource_class]`
 *     is undefined (partial override — only some classes overridden).
 *
 * Operational observability: the function does NOT emit a structured
 * log on resolution. Callers that need per-resolution visibility add
 * it via `@cortex/observability` at their layer; the resolver is a
 * thin lookup. (No `@cortex/secrets`-style operational audit log —
 * that pattern is specific to credentials/keys, not quotas.)
 *
 * RLS: `tenant_config_version` has FOR ALL RLS policy (per migration
 * 0007). Caller MUST bind session via `bindTenantToDbSession` before
 * passing `db` in `ctx`. The resolver does not bind — the caller's
 * transaction may already have its own session-bound state.
 *
 * Type-coercion at the JSON boundary: `config_json` is jsonb, which
 * is JSON-deserialized on read. JSON has no native bigint type, so
 * override values come back as `number` (or `string` if a future
 * caller serializes them that way). The resolver coerces to `bigint`
 * via `BigInt(override)` for type safety. `DEFAULT_TIER_QUOTAS` values
 * are bigint literals (`600n`, etc.) and pass through unchanged.
 *
 * The defaults are TUNABLE baselines, not load-derived truths. Callers
 * seeing 429s on legitimate traffic should adjust via per-tenant
 * overrides in `tenant_config_version`, NOT by widening the constants.
 * Planning doc Decision 7 captures the "defaults exist as a floor,
 * not a target" framing.
 */

import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenantConfigVersion } from '@cortex/canonical-schema';
import { DEFAULT_TIER_QUOTAS, type QuotaTier, type ResourceClass } from './types.js';

/**
 * Returns the quota limit for a `(tier, resourceClass)` pair, optionally
 * checking for a per-tenant override.
 *
 * @param tier - Tenant's commercial tier (`'STANDARD' | 'ENTERPRISE'`).
 * @param resourceClass - The quota dimension being checked.
 * @param ctx - Optional per-tenant override consultation. When both
 *   `tenantId` and `db` are supplied, queries
 *   `tenant_config_version.config_json.quotas[resourceClass]`. When
 *   either is missing, falls through to the tier default.
 * @returns BigInt quota limit.
 */
export async function getQuotaConfig(
  tier: QuotaTier,
  resourceClass: ResourceClass,
  ctx?: { tenantId?: string; db?: NodePgDatabase<Record<string, never>> },
): Promise<bigint> {
  if (ctx?.tenantId !== undefined && ctx.db !== undefined) {
    const rows = await ctx.db
      .select({ config_json: tenantConfigVersion.config_json })
      .from(tenantConfigVersion)
      .where(eq(tenantConfigVersion.tenant_id, ctx.tenantId))
      .orderBy(desc(tenantConfigVersion.version_number))
      .limit(1);

    const config = rows[0]?.config_json;
    const override = (config as { quotas?: Record<string, unknown> } | undefined)?.quotas?.[
      resourceClass
    ];
    if (override !== undefined) {
      return typeof override === 'bigint' ? override : BigInt(override as number | string);
    }
  }

  return DEFAULT_TIER_QUOTAS[tier][resourceClass];
}

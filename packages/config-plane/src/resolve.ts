/**
 * F04 Slice C — `resolveConfig` layered resolver.
 *
 * Per Q-NEW-F04C-1 (deepest-wins inheritance) + Q-NEW-F04C-2
 * (workspace deferred per D14): walks 3 tiers in Phase 1.
 *
 *   1. `tenant.<namespace>` literal — per-tenant override
 *   2. `platform.<namespace>` literal — platform-shaped default
 *      (note: stored as tenant-scoped row per D14; NOT a true
 *      cross-tenant default. See CLAUDE.md `### Layered config
 *      resolution` for the nuance.)
 *   3. Consumer's registered `defaultValue` — the genuine
 *      cross-tenant default (in-code, not DB)
 *
 * Caching per Q-NEW-F04C-3 + C-4: per-process LRU keyed on
 * `(tenant_id, namespace)`. Consumer's `ttl` from registration
 * applies (default 60s). Cache hits return immediately without
 * walking tiers.
 *
 * Active invalidation per Q-NEW-F04C-5: F04 Slice B's lifecycle
 * helpers call `invalidate(tenantId, namespace)` after audit emit.
 *
 * Forward-compat insertion point for workspace tier (when D14
 * eventually unblocks it):
 *
 *   // Resolver walk order (post-workspace-namespace-ship):
 *   // 1. workspace.<wid>.<namespace> for current tenant + workspace
 *   // 2. tenant.<namespace> for current tenant
 *   // 3. platform.<namespace> for current tenant
 *   // 4. registered default
 */

import type { Queryable } from './queryable.js';
import { getConfig } from './get-config.js';
import { cacheGet, cacheSet } from './cache.js';
import { getConfigConsumer, DEFAULT_CONSUMER_TTL_SECONDS } from './consumer-registry.js';

/**
 * Resolve the value of a logical config namespace for a tenant.
 *
 * Walks tenant tier → platform tier → registered default. Returns
 * `null` only when no DB rows exist at either tier AND no consumer
 * is registered (or consumer registered `defaultValue: null`
 * deliberately). Cache-mediated; respects TTL + active invalidation.
 *
 * Schema validation runs inside `getConfig` for whichever tier's
 * row is read — the row's pinned `schema_version` is looked up
 * against the registered schema for that literal namespace
 * (`tenant.<ns>` or `platform.<ns>`). `registerConfigConsumer`
 * registers identical schemas at both tiers, so validation is
 * consistent regardless of which tier returned the row.
 */
export async function resolveConfig<T>(
  client: Queryable,
  tenantId: string,
  namespace: string,
): Promise<T | null> {
  // Cache check first. Returns hit (with possibly-null value) or
  // undefined for miss/expired.
  const cached = cacheGet<T>(tenantId, namespace);
  if (cached !== undefined) return cached.value;

  const consumer = getConfigConsumer<T>(namespace);
  const ttl = consumer?.ttlSeconds ?? DEFAULT_CONSUMER_TTL_SECONDS;

  // Tier 1: tenant.<namespace>
  const tenantValue = await getConfig<T>(client, tenantId, `tenant.${namespace}`);
  if (tenantValue !== null) {
    cacheSet(tenantId, namespace, tenantValue, ttl);
    return tenantValue;
  }

  // Tier 2: platform.<namespace>
  const platformValue = await getConfig<T>(client, tenantId, `platform.${namespace}`);
  if (platformValue !== null) {
    cacheSet(tenantId, namespace, platformValue, ttl);
    return platformValue;
  }

  // Tier 3: registered default. May itself be null if consumer
  // chose null-on-no-row OR if no consumer is registered. Both
  // cases cache the null to avoid re-walking on subsequent reads.
  const defaultValue = consumer?.defaultValue ?? null;
  cacheSet(tenantId, namespace, defaultValue, ttl);
  return defaultValue;
}

/**
 * Re-export from cache.ts for callers that need to invalidate
 * outside the lifecycle helpers (e.g., test cleanup, manual
 * cache-bust during admin operations).
 *
 * F04 Slice B's `promoteDraft` + `rollbackVersion` import this
 * directly to call after audit emit (Q-NEW-F04C-5 active
 * invalidation).
 */
export { cacheInvalidate as invalidateResolverCache } from './cache.js';

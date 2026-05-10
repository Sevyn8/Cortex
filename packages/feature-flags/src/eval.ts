/**
 * P1.6 Slice A — `isEnabled` + `getVariant` evaluation engine.
 *
 * Per Q-NEW-FF-A-3 lock: hybrid signature — `(client, tenantId, params)`
 * matching F04 `promoteDraft` precedent.
 *
 * Per Q-NEW-FF-A-6 lock (load-bearing): per-key tier-walk in eval.ts:
 *   1. Read `tenant.feature-flags` via `getConfig`.
 *   2. Read `platform.feature-flags` via `getConfig`.
 *   3. Read consumer's registered `defaultValue` (the in-code defaults
 *      from `initial-flags.ts`).
 *   4. Per-key precedence: tenant > platform > consumer-default; for
 *      missing flags, return `false` from `isEnabled` / `null` from
 *      `getVariant`.
 *
 * P1.6 caches the merged record per-tenant (TTL=30s) — F04's resolver
 * cache returns whole-tier JSON without merging, so it's not reusable
 * for P1.6's per-key precedence. See `cache.ts` for the rationale +
 * roadmap §1.18 trigger for future abstraction.
 *
 * Per-flag-type evaluation:
 *   - `boolean`: `isEnabled` returns `flag.default`. Tenant overrides
 *     happen at the substrate level (a different `default` value in
 *     tenant.feature-flags JSON for that key).
 *   - `variant`: `isEnabled` returns FALSE (variant flags don't have
 *     boolean truthiness; callers should use `getVariant`). `getVariant`
 *     returns `flag.default`.
 *   - `percentage`: `isEnabled` hashes `(userId, flagKey)` to bucket
 *     [0, 99]; bucket < `rollout_percentage` → `!flag.default`,
 *     otherwise `flag.default`. Anonymous calls (`userId === undefined`)
 *     return `flag.default` — no rollout participation.
 */

import { type Queryable, getConfig, getConfigConsumer } from '@cortex/config-plane';
import {
  FEATURE_FLAGS_NAMESPACE,
  FEATURE_FLAGS_TTL_SECONDS,
  type FeatureFlagsNamespace,
  type FlagDefinition,
} from './registration.js';
import { flagsCacheGet, flagsCacheSet } from './cache.js';
import { rolloutBucket } from './rollout.js';

export interface EvalParams {
  /** Flag key — e.g., `'agents.planogram.v2-model'`. */
  flagKey: string;
  /**
   * Optional user identifier. Used by `percentage` flags for
   * deterministic bucket assignment. When omitted, percentage flags
   * return their `default` (no rollout participation for anonymous
   * calls).
   */
  userId?: string;
}

/**
 * Resolve the merged flag-set for a tenant via per-key tier-walk.
 *
 * Cache-mediated: TTL=30s per-tenant LRU. Cache miss reads both DB
 * tiers + consumer default, merges, caches.
 *
 * Caller must pre-bind tenant context for RLS (matches F04 `getConfig`
 * contract — RLS-bound caller; tenantId-as-query-parameter is defense-
 * in-depth).
 */
async function resolveAllFlags(
  client: Queryable,
  tenantId: string,
): Promise<FeatureFlagsNamespace> {
  const cached = flagsCacheGet(tenantId);
  if (cached !== undefined) return cached;

  // Per-tier reads. F04's `getConfig` returns null when no row exists
  // at the literal namespace; we treat null as empty record.
  const tenantConfig =
    (await getConfig<FeatureFlagsNamespace>(
      client,
      tenantId,
      `tenant.${FEATURE_FLAGS_NAMESPACE}`,
    )) ?? {};
  const platformConfig =
    (await getConfig<FeatureFlagsNamespace>(
      client,
      tenantId,
      `platform.${FEATURE_FLAGS_NAMESPACE}`,
    )) ?? {};

  // Consumer default — the in-code fallback (Slice C tier 3 per F04
  // Q-NEW-F04C-2). For P1.6, this is populated by `initial-flags.ts`
  // at registration time with the 4 named flags.
  const consumer = getConfigConsumer<FeatureFlagsNamespace>(FEATURE_FLAGS_NAMESPACE);
  const consumerDefault: FeatureFlagsNamespace = consumer?.defaultValue ?? {};

  // Per-key precedence (lowest → highest priority): consumer default
  // < platform < tenant. Spread order matters — later keys win.
  const merged: FeatureFlagsNamespace = {
    ...consumerDefault,
    ...platformConfig,
    ...tenantConfig,
  };
  flagsCacheSet(tenantId, merged, FEATURE_FLAGS_TTL_SECONDS);
  return merged;
}

/**
 * Evaluate a feature flag for `(tenantId, userId?, flagKey)`.
 *
 * Returns `false` for unknown flag keys (missing from all 3 tiers).
 * Returns `false` for variant flags (callers should use `getVariant`).
 *
 * Throws if the substrate read fails (F04 propagation; e.g., RLS
 * denial when tenant context isn't bound).
 */
export async function isEnabled(
  client: Queryable,
  tenantId: string,
  params: EvalParams,
): Promise<boolean> {
  const flags = await resolveAllFlags(client, tenantId);
  const flag = flags[params.flagKey];
  if (flag === undefined) return false;
  return evaluateBoolean(flag, params.flagKey, params.userId);
}

/**
 * Evaluate a variant flag. Returns `null` for unknown flag keys OR
 * for non-variant flags (boolean / percentage callers should use
 * `isEnabled` instead).
 */
export async function getVariant(
  client: Queryable,
  tenantId: string,
  params: EvalParams,
): Promise<string | null> {
  const flags = await resolveAllFlags(client, tenantId);
  const flag = flags[params.flagKey];
  if (flag?.type !== 'variant') return null;
  // Phase 1: variant flags return their configured default. Per-user
  // variant assignment (attribute-based targeting) defers to Phase 2
  // per D2 + AC01 user-attribute substrate dependency.
  return flag.default;
}

function evaluateBoolean(
  flag: FlagDefinition,
  flagKey: string,
  userId: string | undefined,
): boolean {
  switch (flag.type) {
    case 'boolean':
      return flag.default;
    case 'variant':
      // Variant flags have no boolean truthiness; callers should use
      // `getVariant`. Returning `false` here matches the convention
      // documented in eval.ts header.
      return false;
    case 'percentage': {
      // Anonymous calls (userId omitted) don't participate in
      // gradual rollout — return the default per Q-NEW-FF-A-2.
      if (userId === undefined) return flag.default;
      const bucket = rolloutBucket(userId, flagKey);
      // Convention: rollout_percentage = % of users who see the
      // FLIPPED state. bucket < pct → !default; else default.
      return bucket < flag.rollout_percentage ? !flag.default : flag.default;
    }
  }
}

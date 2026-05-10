/**
 * P1.6 Slice A — Per-process LRU cache for resolved flag-set per
 * tenant. Mirrors F04 Slice C's `cache.ts` pattern (Map-based; size-
 * bounded with TTL eviction; no external dep).
 *
 * Why a separate cache from F04's resolver cache:
 *   F04's `resolveConfig` returns the FIRST non-null tier's whole-
 *   namespace JSON; it does NOT do per-key tier merging. P1.6's
 *   `eval.ts` performs per-key precedence (tenant > platform >
 *   consumer-default) which yields a merged record that F04's cache
 *   doesn't capture. So P1.6 caches the merged result keyed by
 *   `tenantId` alone — a single read populates all flag values for
 *   the tenant; subsequent `isEnabled`/`getVariant` calls for the
 *   same tenant hit the cache (sub-1ms p99).
 *
 * Cache key shape: `tenantId` (string).
 * Cache value: `Record<flagKey, FlagDefinition>` — the merged set.
 * TTL: 30s (matches F04 consumer-registration `ttl=30` per Q-NEW-FF-A-3).
 *
 * **Active invalidation gap.** F04's lifecycle invalidates F04's own
 * resolver cache on `promoteDraft` for the `feature-flags` namespace,
 * but P1.6's cache is independent and not reachable from F04. Phase 1
 * relies on TTL=30s passive expiry — satisfies criterion 1 (30s
 * propagation). Active invalidation reach is tracked at roadmap
 * §1.18 (per-key tier-walk abstraction) — first candidate fix is
 * extracting P1.6's merge logic into F04 so both caches share the
 * invalidation surface.
 */

import type { FeatureFlagsNamespace } from './registration.js';

const DEFAULT_MAX_ENTRIES = 1024;

interface CacheEntry {
  value: FeatureFlagsNamespace;
  expiresAt: number;
}

let maxEntries = DEFAULT_MAX_ENTRIES;
const cache = new Map<string, CacheEntry>();

/**
 * Look up a tenant's merged flag-set. Returns `undefined` for miss
 * (key absent OR expired). TTL expiry is checked on `get`.
 */
export function flagsCacheGet(tenantId: string): FeatureFlagsNamespace | undefined {
  const entry = cache.get(tenantId);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(tenantId);
    return undefined;
  }
  return entry.value;
}

/**
 * Set a tenant's merged flag-set with TTL. Evicts the oldest entry
 * by Map insertion order if cache exceeds size limit (poor-man's
 * LRU; same approach as F04's `cache.ts`).
 */
export function flagsCacheSet(
  tenantId: string,
  value: FeatureFlagsNamespace,
  ttlSeconds: number,
): void {
  // Re-insertion bumps the entry to most-recently-inserted position
  // (Map preserves insertion order; delete + re-set is the LRU bump
  // idiom mirrored from F04's cache.ts).
  cache.delete(tenantId);
  cache.set(tenantId, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

/**
 * Manual invalidation. Used by tests to force cache misses; could
 * also be wired to F04 lifecycle events when roadmap §1.18 lands
 * (currently Phase 1 relies on TTL=30s passive expiry).
 */
export function flagsCacheInvalidate(tenantId: string): void {
  cache.delete(tenantId);
}

/** Test-only — clears all entries. */
export function flagsCacheClear(): void {
  cache.clear();
}

/** Test-only — set the max-entries cap for size-eviction tests. */
export function setFlagsCacheMaxEntries(value: number): void {
  maxEntries = value;
}

/** Test-only — read the current entry count. */
export function flagsCacheSize(): number {
  return cache.size;
}

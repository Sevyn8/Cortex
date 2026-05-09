/**
 * F04 Slice C — per-process LRU cache for resolved config values.
 *
 * Per Q-NEW-F04C-3 (60s default TTL + per-consumer override) +
 * Q-NEW-F04C-4 (key shape `(tenant_id, namespace)`):
 *
 *   - Map-based; size-bounded with TTL eviction. No external dep.
 *   - Cache key: `${tenantId}::${namespace}` — string-flattened tuple
 *     for Map keying; namespace is the LOGICAL name (no tier prefix)
 *     because the resolver caches the FINAL resolved value, not the
 *     per-tier read result.
 *   - Cached value can be `null` (consumer registered no default AND
 *     no DB row exists at any tier — semantic "no value"; cache the
 *     null to avoid re-reading the same empty result repeatedly).
 *   - TTL applied at `set()` time; expired entries are silently
 *     evicted on next `get()`.
 *
 * Active invalidation per Q-NEW-F04C-5 — F04 Slice B's lifecycle
 * helpers (promoteDraft + rollbackVersion) call `invalidate()` after
 * audit emit so freshly-promoted values are visible immediately on
 * the local replica. Multi-replica deploy still has TTL-bounded
 * staleness (deferred to roadmap §1.12 Redis migration).
 *
 * Phase 1 single-replica deploy: per-process LRU is sufficient.
 * Multi-replica deploy needs Redis-backed cache + Pub/Sub-based
 * invalidation broadcast — tracked at roadmap §1.12.
 */

const DEFAULT_MAX_ENTRIES = 1000;

interface CacheEntry<T = unknown> {
  /** Cached value. `null` means "no DB row + no default" — semantic miss. */
  value: T | null;
  /** Epoch ms after which the entry is considered expired. */
  expiresAt: number;
}

/**
 * Test-only / config knob for cache size. Exposed so future tuning
 * doesn't require recompiling the constant. Default 1000 entries =
 * ~10MB worst case (per-tenant resolved-blob ~10KB).
 */
let maxEntries = DEFAULT_MAX_ENTRIES;

const cache = new Map<string, CacheEntry>();

function makeKey(tenantId: string, namespace: string): string {
  return `${tenantId}::${namespace}`;
}

/**
 * Look up a cached entry. Returns `undefined` for cache miss (key
 * absent OR expired). Returns `{ value }` (where `value` may itself
 * be `null`) for cache hit.
 *
 * Distinguishing "miss" from "hit with null value" matters for the
 * resolver: a hit means we already walked the tier chain; a miss
 * means we need to walk again.
 */
export function cacheGet<T>(tenantId: string, namespace: string): { value: T | null } | undefined {
  const key = makeKey(tenantId, namespace);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return { value: entry.value as T | null };
}

/**
 * Set a cached entry with TTL. `ttlSeconds` is per-consumer override
 * (default 60s applied by the resolver if no override). Evicts the
 * oldest entry by insertion order if cache exceeds size limit
 * (poor-man's LRU — Map iterates in insertion order; we rebuild
 * insertion-order on set by deleting + re-setting).
 */
export function cacheSet<T>(
  tenantId: string,
  namespace: string,
  value: T | null,
  ttlSeconds: number,
): void {
  const key = makeKey(tenantId, namespace);
  // Re-insertion moves the entry to the most-recently-used position
  // in Map's iteration order (Map preserves insertion order; deleting
  // + re-setting is the idiom for LRU bump).
  cache.delete(key);
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  // Evict oldest if over size limit.
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

/**
 * Active invalidation per Q-NEW-F04C-5. Called by F04 Slice B's
 * promoteDraft + rollbackVersion after audit emit. Idempotent —
 * deleting a missing key is a no-op.
 */
export function cacheInvalidate(tenantId: string, namespace: string): void {
  cache.delete(makeKey(tenantId, namespace));
}

/**
 * Test-only — clears all entries. Production code should never
 * call this; the cache is meant to fill organically + evict via
 * TTL/size limit.
 */
export function cacheClear(): void {
  cache.clear();
}

/**
 * Test-only — set the max-entries cap. Exposed so size-eviction
 * tests don't need to fill 1000+ entries to trigger the path.
 */
export function setCacheMaxEntries(value: number): void {
  maxEntries = value;
}

/**
 * Test-only — read the current entry count. Exposed for tests that
 * verify cache state without exposing the Map directly.
 */
export function cacheSize(): number {
  return cache.size;
}

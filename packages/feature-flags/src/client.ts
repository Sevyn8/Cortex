/**
 * P1.6 Slice B — Framework-agnostic non-React client shim.
 *
 * Per Q-NEW-FF-B-1 lock (e): client library calls Slice B's HTTP
 * endpoint (`GET /v1/feature-flags?userId=...`) and exposes a
 * subscription + cache surface for callers (admin UI, future React
 * hooks, etc.).
 *
 * Per Q-NEW-FF-B-4 lock: polling at 30s default interval (matches
 * Slice A TTL=30s + criterion 1's 30s propagation requirement).
 * `pollIntervalMs` is configurable for fast tests via fake timers.
 * `refresh()` API exposed for explicit-bypass callers (admin UI
 * post-promote). SSE deferred to Phase 2.
 *
 * No DOM dependency — runs in Node + browser. Caller supplies `fetch`
 * if running where global fetch isn't available (older Node, custom
 * transport).
 *
 * Notification semantics: subscribers fire ONLY when their flag's
 * value changes between polls (diff-based). Subscribing to a flag
 * that hasn't been fetched yet returns the cached value (`undefined`
 * if never fetched) — caller can call `refresh()` first to ensure
 * a value exists before subscribing.
 */

import type { FlagEvaluation } from './eval.js';

export interface FeatureFlagsClientOptions {
  /** Base URL of the `feature-flags-api` service (e.g., `https://api.example.com`). */
  baseUrl: string;
  /** Tenant identifier — sent as `x-cortex-tenant-id` header. */
  tenantId: string;
  /** Optional user identifier — sent as `userId` query param for percentage-rollout bucket assignment. */
  userId?: string;
  /**
   * Optional fetch implementation. Defaults to global `fetch`.
   * Override for environments without global fetch (older Node) or
   * for test-controlled HTTP responses.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Polling interval in milliseconds. Defaults to 30000 (30s),
   * matching Slice A's cache TTL and criterion 1's propagation
   * requirement. Set to `0` to disable polling — caller drives
   * refreshes manually via `refresh()`.
   */
  pollIntervalMs?: number;
}

export type FlagSubscriber = (value: FlagEvaluation | undefined) => void;

export interface FeatureFlagsClient {
  /**
   * Read the cached value for a flag. Returns `undefined` if the
   * flag hasn't been fetched yet (caller hasn't called `refresh()`
   * AND polling hasn't yet ticked) OR if the flag isn't registered
   * for this tenant.
   */
  getCachedValue(flagKey: string): FlagEvaluation | undefined;
  /**
   * Subscribe to value changes for a flag. Callback fires ONLY when
   * the flag's value (`type` + `value` deep-equality) changes
   * between polls. Returns an `unsubscribe` function.
   *
   * Does NOT fire immediately with the current value — caller reads
   * via `getCachedValue` if they want the current snapshot.
   */
  subscribe(flagKey: string, callback: FlagSubscriber): () => void;
  /**
   * Force-refresh the cache. Bypasses the polling timer; bulk-fetches
   * all flags from the server; notifies any subscribers whose flag
   * values changed.
   */
  refresh(): Promise<void>;
  /**
   * Clear the cached snapshot. Subscribers DO NOT fire from
   * invalidation (they only fire on observed value changes after
   * a subsequent `refresh()`).
   */
  invalidate(): void;
  /**
   * Stop the polling timer + clear all subscribers + invalidate.
   * Idempotent. Test-cleanup-friendly.
   */
  dispose(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Create a feature-flags client. Polling starts immediately on
 * creation (first tick after `pollIntervalMs`); call `refresh()`
 * synchronously after creation to populate the cache before first
 * `getCachedValue` reads.
 */
export function createFeatureFlagsClient(opts: FeatureFlagsClientOptions): FeatureFlagsClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const tenantId = opts.tenantId;
  const userId = opts.userId;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'createFeatureFlagsClient: no fetch implementation available — pass `fetch` in options or run in an environment with global fetch.',
    );
  }

  // In-memory cache + subscriber registry. Per-flag subscribers are
  // a Set so unsubscribe is O(1).
  const cache = new Map<string, FlagEvaluation>();
  const subscribers = new Map<string, Set<FlagSubscriber>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  function getCachedValue(flagKey: string): FlagEvaluation | undefined {
    return cache.get(flagKey);
  }

  function subscribe(flagKey: string, callback: FlagSubscriber): () => void {
    if (disposed) {
      throw new Error('createFeatureFlagsClient: client has been disposed.');
    }
    let set = subscribers.get(flagKey);
    if (set === undefined) {
      set = new Set();
      subscribers.set(flagKey, set);
    }
    set.add(callback);
    return () => {
      const s = subscribers.get(flagKey);
      if (s === undefined) return;
      s.delete(callback);
      if (s.size === 0) subscribers.delete(flagKey);
    };
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    const url =
      userId !== undefined
        ? `${baseUrl}/v1/feature-flags?userId=${encodeURIComponent(userId)}`
        : `${baseUrl}/v1/feature-flags`;
    const response = await fetchImpl(url, {
      headers: {
        'x-cortex-tenant-id': tenantId,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(
        `feature-flags-client: bulk fetch failed with status ${response.status} from ${url}`,
      );
    }
    const body = (await response.json()) as { flags: Record<string, FlagEvaluation> };
    if (body === null || typeof body !== 'object' || typeof body.flags !== 'object') {
      throw new Error(
        'feature-flags-client: bulk fetch response missing `flags` object — unexpected schema.',
      );
    }
    applyFlags(body.flags);
  }

  function applyFlags(next: Record<string, FlagEvaluation>): void {
    // Diff-detect changes; notify subscribers whose flag's
    // (type, value) pair changed.
    const seen = new Set<string>();
    for (const [flagKey, nextValue] of Object.entries(next)) {
      seen.add(flagKey);
      const prev = cache.get(flagKey);
      if (!flagsEqual(prev, nextValue)) {
        cache.set(flagKey, nextValue);
        notifySubscribers(flagKey, nextValue);
      }
    }
    // Flags that disappeared from the server's response — clear
    // from cache + notify subscribers with `undefined`.
    for (const flagKey of Array.from(cache.keys())) {
      if (!seen.has(flagKey)) {
        cache.delete(flagKey);
        notifySubscribers(flagKey, undefined);
      }
    }
  }

  function notifySubscribers(flagKey: string, value: FlagEvaluation | undefined): void {
    const set = subscribers.get(flagKey);
    if (set === undefined) return;
    for (const callback of set) {
      try {
        callback(value);
      } catch {
        // Subscriber threw — swallow. Compliance auditors can wire
        // structured logging here when observability is added; for
        // now, isolate caller bugs from each other.
      }
    }
  }

  function invalidate(): void {
    cache.clear();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    subscribers.clear();
    cache.clear();
  }

  // Start polling unless disabled (pollIntervalMs === 0).
  if (pollIntervalMs > 0) {
    timer = setInterval(() => {
      // Swallow polling errors so a transient network blip doesn't
      // crash the host process. Subscribers stay on stale-but-cached
      // values until next successful poll.
      void refresh().catch(() => undefined);
    }, pollIntervalMs);
  }

  return {
    getCachedValue,
    subscribe,
    refresh,
    invalidate,
    dispose,
  };
}

function flagsEqual(a: FlagEvaluation | undefined, b: FlagEvaluation | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.type === b.type && a.value === b.value;
}

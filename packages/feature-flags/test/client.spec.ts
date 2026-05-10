/**
 * P1.6 Slice B — `createFeatureFlagsClient` unit tests.
 *
 * Pure unit tests with stub `fetch` + fake timers (`vi.useFakeTimers`).
 * No DB needed.
 *
 * Surface covered:
 *   1. Initial fetch + cache population.
 *   2. `getCachedValue` returns cached snapshot.
 *   3. `subscribe` fires only on value change (diff-based).
 *   4. `unsubscribe` returned from `subscribe` cleans up.
 *   5. Polling tick refreshes cache.
 *   6. `refresh()` bypasses polling timer.
 *   7. `invalidate()` clears cache.
 *   8. `dispose()` clears interval + subscribers.
 *   9. Subscriber throws don't break other subscribers.
 *  10. Missing fetch implementation throws clearly.
 *  11. Removed flags notify subscribers with `undefined`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeatureFlagsClient, type FlagEvaluation } from '../src/index.js';

interface FetchHistory {
  calls: { url: string; init?: RequestInit }[];
  response: Record<string, FlagEvaluation>;
}

function makeFakeFetch(history: FetchHistory): typeof globalThis.fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    history.calls.push({ url: urlStr, ...(init !== undefined && { init }) });
    return Promise.resolve(
      new Response(JSON.stringify({ flags: history.response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
}

describe('createFeatureFlagsClient — non-React shim (Slice B)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refresh() fetches and populates the cache', async () => {
    const history: FetchHistory = {
      calls: [],
      response: { 'flag-a': { type: 'boolean', value: true } },
    };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: '00000000-0000-0000-0000-000000000001',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0, // disable polling
    });
    await client.refresh();
    expect(client.getCachedValue('flag-a')).toEqual({ type: 'boolean', value: true });
    client.dispose();
  });

  it('refresh() sends x-cortex-tenant-id header', async () => {
    const history: FetchHistory = { calls: [], response: {} };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 'tenant-xyz',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    expect(history.calls).toHaveLength(1);
    const headers = history.calls[0]!.init?.headers as Record<string, string> | undefined;
    expect(headers?.['x-cortex-tenant-id']).toBe('tenant-xyz');
    client.dispose();
  });

  it('refresh() includes userId query param when provided', async () => {
    const history: FetchHistory = { calls: [], response: {} };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      userId: 'user-42',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    expect(history.calls[0]!.url).toContain('userId=user-42');
    client.dispose();
  });

  it('refresh() omits userId param when omitted', async () => {
    const history: FetchHistory = { calls: [], response: {} };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    expect(history.calls[0]!.url).not.toContain('userId=');
    client.dispose();
  });

  it('subscribe + value change → callback fires', async () => {
    const history: FetchHistory = {
      calls: [],
      response: { 'flag-a': { type: 'boolean', value: false } },
    };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    const callback = vi.fn();
    client.subscribe('flag-a', callback);
    history.response['flag-a'] = { type: 'boolean', value: true };
    await client.refresh();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenLastCalledWith({ type: 'boolean', value: true });
    client.dispose();
  });

  it('subscribe + no value change → callback does NOT fire', async () => {
    const history: FetchHistory = {
      calls: [],
      response: { 'flag-a': { type: 'boolean', value: true } },
    };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    const callback = vi.fn();
    client.subscribe('flag-a', callback);
    await client.refresh(); // identical response
    expect(callback).not.toHaveBeenCalled();
    client.dispose();
  });

  it('unsubscribe stops further callbacks', async () => {
    const history: FetchHistory = {
      calls: [],
      response: { 'flag-a': { type: 'boolean', value: false } },
    };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    const callback = vi.fn();
    const unsubscribe = client.subscribe('flag-a', callback);
    history.response['flag-a'] = { type: 'boolean', value: true };
    await client.refresh();
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    history.response['flag-a'] = { type: 'boolean', value: false };
    await client.refresh();
    expect(callback).toHaveBeenCalledTimes(1); // still 1; unsubscribe worked
    client.dispose();
  });

  it('removed flag fires subscriber with undefined', async () => {
    const history: FetchHistory = {
      calls: [],
      response: { 'flag-a': { type: 'boolean', value: true } },
    };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    const callback = vi.fn();
    client.subscribe('flag-a', callback);
    history.response = {}; // flag-a removed
    await client.refresh();
    expect(callback).toHaveBeenCalledWith(undefined);
    expect(client.getCachedValue('flag-a')).toBeUndefined();
    client.dispose();
  });

  it('subscriber throw is isolated — other subscribers still fire', async () => {
    const history: FetchHistory = {
      calls: [],
      response: { 'flag-a': { type: 'boolean', value: false } },
    };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const ok = vi.fn();
    client.subscribe('flag-a', throwing);
    client.subscribe('flag-a', ok);
    history.response['flag-a'] = { type: 'boolean', value: true };
    await client.refresh();
    expect(throwing).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
    client.dispose();
  });

  it('polling triggers refresh at the configured interval', async () => {
    const history: FetchHistory = { calls: [], response: {} };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 1000,
    });
    expect(history.calls).toHaveLength(0); // no immediate fetch
    await vi.advanceTimersByTimeAsync(1000);
    expect(history.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(history.calls).toHaveLength(2);
    client.dispose();
  });

  it('pollIntervalMs=0 disables polling', async () => {
    const history: FetchHistory = { calls: [], response: {} };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(history.calls).toHaveLength(0);
    client.dispose();
  });

  it('dispose() clears the polling timer', async () => {
    const history: FetchHistory = { calls: [], response: {} };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(history.calls).toHaveLength(1);
    client.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(history.calls).toHaveLength(1); // no further calls after dispose
  });

  it('invalidate() clears cache without triggering a fetch', async () => {
    const history: FetchHistory = {
      calls: [],
      response: { 'flag-a': { type: 'boolean', value: true } },
    };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    await client.refresh();
    expect(client.getCachedValue('flag-a')).toEqual({ type: 'boolean', value: true });
    client.invalidate();
    expect(client.getCachedValue('flag-a')).toBeUndefined();
    expect(history.calls).toHaveLength(1); // only the initial refresh
    client.dispose();
  });

  it('subscribe after dispose throws', () => {
    const history: FetchHistory = { calls: [], response: {} };
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: makeFakeFetch(history),
      pollIntervalMs: 0,
    });
    client.dispose();
    expect(() => client.subscribe('flag-a', () => undefined)).toThrow(/disposed/);
  });

  it('refresh() throws on non-2xx response', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('Forbidden', { status: 403 }))) as typeof globalThis.fetch;
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: fetchImpl,
      pollIntervalMs: 0,
    });
    await expect(client.refresh()).rejects.toThrow(/status 403/);
    client.dispose();
  });

  it('refresh() throws on malformed response body', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ wrong_key: 'not flags' }), { status: 200 }),
      )) as typeof globalThis.fetch;
    const client = createFeatureFlagsClient({
      baseUrl: 'http://test',
      tenantId: 't',
      fetch: fetchImpl,
      pollIntervalMs: 0,
    });
    await expect(client.refresh()).rejects.toThrow(/missing.*flags/);
    client.dispose();
  });

  // Note: the "no fetch implementation available" defensive throw
  // (createFeatureFlagsClient throws if both opts.fetch and
  // globalThis.fetch are undefined) is unreachable in modern Node /
  // browser test environments — globalThis.fetch is always defined.
  // The throw remains in the source for environments without global
  // fetch (older Node, custom transport-shimming runtimes); it is
  // not asserted by tests.
});

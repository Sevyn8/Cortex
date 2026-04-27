import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  __resetForTesting,
  __setCheckerForTesting,
  buildQuotaMiddlewareCore,
  expressQuotaMiddleware,
  honoQuotaMiddleware,
  type CheckQuotaResult,
  type QuotaMiddlewareOptions,
} from '../src/index.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  __resetForTesting();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Inject a mock checker that returns the canned result. Returns the
 * spy so tests can assert call args / count. `__setCheckerForTesting`
 * redirects the module-scope `defaultChecker`; the middleware's
 * `checkQuota(...)` convenience export delegates through that
 * defaultChecker, so this catch-all redirect covers all middleware
 * paths.
 */
function setMockChecker(canned: CheckQuotaResult): Mock {
  const fn = vi.fn(() => Promise.resolve(canned));
  __setCheckerForTesting({ check: fn });
  return fn;
}

/**
 * Standard middleware-options stub. Tests pick & override fields they
 * care about. `getDb` returns the no-override mock — the mock checker
 * doesn't use the db, but `getQuotaConfig`'s F02-swap path (called by
 * the middleware to consult `tenant_config_version` for per-tenant
 * overrides) does. Returning empty rows from the select chain
 * preserves the per-tier-default behavior these tests assume.
 */
function baseOpts(overrides: Partial<QuotaMiddlewareOptions> = {}): QuotaMiddlewareOptions {
  return {
    resolveResourceClass: () => 'api_calls_per_minute',
    resolveTenantId: () => TENANT_ID,
    resolveTier: () => Promise.resolve('STANDARD'),
    getDb: () => noOverrideDb,
    ...overrides,
  };
}

/**
 * Mock db that returns empty rows for `getQuotaConfig`'s select chain
 * (`select().from().where().orderBy().limit()` → []). Lets `getQuotaConfig`'s
 * F02-swap branch fall through to `DEFAULT_TIER_QUOTAS` cleanly. Tests
 * that need to exercise per-tenant overrides build a richer mock that
 * returns the override row.
 */
const noOverrideDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  }),
} as never;

/** Hono context mock matching the structural HonoContextLike interface. */
function makeHonoCtx(opts: { method: string; path: string }): {
  req: { method: string; path: string };
  json: Mock;
} {
  return {
    req: { method: opts.method, path: opts.path },
    json: vi.fn((data: unknown, status?: number, headers?: Record<string, string>) => ({
      status,
      headers,
      body: data,
    })),
  };
}

/** Express request / response / next mocks (structural). */
function makeExpressMocks(opts: { method?: string; path?: string } = {}): {
  req: { method: string; path: string };
  res: { setHeader: Mock; status: Mock; json: Mock };
  next: Mock;
} {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  // status() must return `res` for the .status(429).json(...) chain.
  res.status.mockReturnValue(res);
  return {
    req: { method: opts.method ?? 'POST', path: opts.path ?? '/api/widgets' },
    res,
    next: vi.fn(),
  };
}

const allowedResult: CheckQuotaResult = {
  allowed: true,
  currentValue: 5n,
  quotaLimit: 600n,
  retryAfterSeconds: null,
  windowStart: '2026-04-26T19:00:00.000Z',
};

const rejectedResult: CheckQuotaResult = {
  allowed: false,
  currentValue: 601n,
  quotaLimit: 600n,
  retryAfterSeconds: 30,
  windowStart: '2026-04-26T19:00:00.000Z',
  resourceClass: 'api_calls_per_minute',
};

// ─────────────────────────────────────────────────────────────────────
// Group: buildQuotaMiddlewareCore — happy paths
// ─────────────────────────────────────────────────────────────────────

describe('buildQuotaMiddlewareCore — happy paths', () => {
  it('skips when path is in skipPaths', async () => {
    const checker = setMockChecker(allowedResult);
    const core = buildQuotaMiddlewareCore(baseOpts({ skipPaths: ['/health', '/readiness'] }));

    const outcome = await core.check({
      method: 'GET',
      path: '/health',
      tenantId: TENANT_ID,
      db: noOverrideDb,
      increment: 1n,
    });

    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) {
      expect(outcome.result).toBeNull();
    }
    expect(checker).not.toHaveBeenCalled();
  });

  it('skips when resolveResourceClass returns null', async () => {
    const checker = setMockChecker(allowedResult);
    const core = buildQuotaMiddlewareCore(baseOpts({ resolveResourceClass: () => null }));

    const outcome = await core.check({
      method: 'GET',
      path: '/whatever',
      tenantId: TENANT_ID,
      db: noOverrideDb,
      increment: 1n,
    });

    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) {
      expect(outcome.result).toBeNull();
    }
    expect(checker).not.toHaveBeenCalled();
  });

  it('forwards a normal request to checkQuota and returns the allowed outcome', async () => {
    const checker = setMockChecker(allowedResult);
    const core = buildQuotaMiddlewareCore(baseOpts());

    const outcome = await core.check({
      method: 'POST',
      path: '/api/widgets',
      tenantId: TENANT_ID,
      db: noOverrideDb,
      increment: 1n,
    });

    expect(outcome.allowed).toBe(true);
    if (outcome.allowed && outcome.result !== null) {
      expect(outcome.result.currentValue).toBe(5n);
    }
    expect(checker).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: buildQuotaMiddlewareCore — rejection
// ─────────────────────────────────────────────────────────────────────

describe('buildQuotaMiddlewareCore — rejection', () => {
  it('translates allowed=false from the checker into outcome.allowed=false with details', async () => {
    setMockChecker(rejectedResult);
    const core = buildQuotaMiddlewareCore(baseOpts());

    const outcome = await core.check({
      method: 'POST',
      path: '/api/widgets',
      tenantId: TENANT_ID,
      db: noOverrideDb,
      increment: 1n,
    });

    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.currentValue).toBe(601n);
      expect(outcome.quotaLimit).toBe(600n);
      expect(outcome.retryAfterSeconds).toBe(30);
      expect(outcome.resourceClass).toBe('api_calls_per_minute');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: resolveQuotaLimit override
// ─────────────────────────────────────────────────────────────────────

describe('buildQuotaMiddlewareCore — resolveQuotaLimit override', () => {
  it('custom resolveQuotaLimit overrides the per-tier default in the checker call', async () => {
    const checker = setMockChecker(allowedResult);
    const core = buildQuotaMiddlewareCore(
      baseOpts({ resolveQuotaLimit: () => Promise.resolve(999n) }),
    );

    await core.check({
      method: 'POST',
      path: '/api/widgets',
      tenantId: TENANT_ID,
      db: noOverrideDb,
      increment: 1n,
    });

    expect(checker).toHaveBeenCalledOnce();
    // checker is called as check(db, params, opts) — opts is the 3rd arg
    const callArgs = checker.mock.calls[0]!;
    const opts = callArgs[2] as { tier: string; quotaLimit: bigint };
    expect(opts.quotaLimit).toBe(999n);
    expect(opts.tier).toBe('STANDARD');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Hono adapter
// ─────────────────────────────────────────────────────────────────────

describe('honoQuotaMiddleware', () => {
  it('allowed result calls next() and returns undefined (Hono "continue" signal)', async () => {
    setMockChecker(allowedResult);
    const middleware = honoQuotaMiddleware(baseOpts());
    const ctx = makeHonoCtx({ method: 'POST', path: '/api/widgets' });
    const next = vi.fn(() => Promise.resolve());

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it('rejection produces 429 + Retry-After header + bigint-as-string body', async () => {
    setMockChecker(rejectedResult);
    const middleware = honoQuotaMiddleware(baseOpts());
    const ctx = makeHonoCtx({ method: 'POST', path: '/api/widgets' });
    const next = vi.fn(() => Promise.resolve());

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledOnce();
    const callArgs = ctx.json.mock.calls[0]!;
    const body = callArgs[0] as Record<string, unknown>;
    const status = callArgs[1] as number;
    const headers = callArgs[2] as Record<string, string>;

    expect(status).toBe(429);
    expect(headers['Retry-After']).toBe('30');

    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.resource_class).toBe('api_calls_per_minute');
    // BigInt → string at the response boundary (planning Decision 8).
    expect(body.current_value).toBe('601');
    expect(body.quota_limit).toBe('600');
    expect(body.retry_after_seconds).toBe(30); // number, not string
  });

  it('skip path bypasses the checker and calls next()', async () => {
    const checker = setMockChecker(allowedResult);
    const middleware = honoQuotaMiddleware(baseOpts({ skipPaths: ['/health'] }));
    const ctx = makeHonoCtx({ method: 'GET', path: '/health' });
    const next = vi.fn(() => Promise.resolve());

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(checker).not.toHaveBeenCalled();
    expect(ctx.json).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Express adapter
// ─────────────────────────────────────────────────────────────────────

describe('expressQuotaMiddleware', () => {
  it('allowed result calls next() with no args and does not modify the response', async () => {
    setMockChecker(allowedResult);
    const middleware = expressQuotaMiddleware(baseOpts());
    const { req, res, next } = makeExpressMocks();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no args = success signal
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('rejection sets Retry-After, status 429, JSON body with bigint-as-string', async () => {
    setMockChecker(rejectedResult);
    const middleware = expressQuotaMiddleware(baseOpts());
    const { req, res, next } = makeExpressMocks();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledOnce();

    const body = res.json.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.resource_class).toBe('api_calls_per_minute');
    expect(body.current_value).toBe('601');
    expect(body.quota_limit).toBe('600');
    expect(body.retry_after_seconds).toBe(30);
  });
});

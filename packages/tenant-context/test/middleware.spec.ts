import { describe, it, expect, vi } from 'vitest';
import { buildTenantContextMiddleware, defaultHeaderExtractor } from '../src/middleware.js';
import { getTenantId } from '../src/context.js';
import { TenantValidationError } from '../src/errors.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

// Structural mocks matching the adapter's HonoContextLike /
// ExpressRequestLike shapes — no Hono / Express runtime imports.

interface HonoMock {
  req: { raw: { headers: Headers }; path: string };
}

function makeHonoCtx(opts: { headers?: Record<string, string>; path?: string }): HonoMock {
  return {
    req: {
      raw: { headers: new Headers(opts.headers ?? {}) },
      path: opts.path ?? '/api/data',
    },
  };
}

interface ExpressMock {
  headers: Record<string, string | string[] | undefined>;
  path: string;
}

function makeExpressReq(opts: {
  headers?: Record<string, string | string[] | undefined>;
  path?: string;
}): ExpressMock {
  return {
    headers: opts.headers ?? {},
    path: opts.path ?? '/api/data',
  };
}

// ─────────────────────────────────────────────────────────────────────
// defaultHeaderExtractor
// ─────────────────────────────────────────────────────────────────────

describe('defaultHeaderExtractor', () => {
  it('reads from x-cortex-tenant-id (case-insensitive across header keys)', () => {
    const lower = defaultHeaderExtractor({
      headers: { 'x-cortex-tenant-id': TENANT_ID },
    });
    const upper = defaultHeaderExtractor({
      headers: { 'X-Cortex-Tenant-Id': TENANT_ID },
    });
    const mixed = defaultHeaderExtractor({
      headers: { 'X-CORTEX-TENANT-ID': TENANT_ID },
    });
    expect(lower).toBe(TENANT_ID);
    expect(upper).toBe(TENANT_ID);
    expect(mixed).toBe(TENANT_ID);
  });

  it('returns the first value when the header is an array', () => {
    const result = defaultHeaderExtractor({
      headers: { 'x-cortex-tenant-id': [TENANT_ID, 'other-value'] },
    });
    expect(result).toBe(TENANT_ID);
  });

  it('returns undefined when the header is missing', () => {
    const result = defaultHeaderExtractor({
      headers: { 'x-other': 'value' },
    });
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// skipPaths
// ─────────────────────────────────────────────────────────────────────

describe('buildTenantContextMiddleware — skipPaths', () => {
  it('bypasses extraction + binding for paths in skipPaths; runs the full flow otherwise', async () => {
    const m = buildTenantContextMiddleware({
      skipPaths: ['/health', '/readiness'],
    });

    let healthSawTenant: string | undefined = 'sentinel';
    await m.hono(makeHonoCtx({ path: '/health' }), () => {
      healthSawTenant = getTenantId();
      return Promise.resolve();
    });
    expect(healthSawTenant).toBeUndefined();

    let apiSawTenant: string | undefined;
    await m.hono(
      makeHonoCtx({
        path: '/api/data',
        headers: { 'x-cortex-tenant-id': TENANT_ID },
      }),
      () => {
        apiSawTenant = getTenantId();
        return Promise.resolve();
      },
    );
    expect(apiSawTenant).toBe(TENANT_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Hono adapter
// ─────────────────────────────────────────────────────────────────────

describe('Hono adapter', () => {
  it('extracts tenant id from headers and runs next() inside withTenantContext', async () => {
    const m = buildTenantContextMiddleware();
    const next = vi.fn((): Promise<void> => {
      expect(getTenantId()).toBe(TENANT_ID);
      return Promise.resolve();
    });
    await m.hono(makeHonoCtx({ headers: { 'x-cortex-tenant-id': TENANT_ID } }), next);
    expect(next).toHaveBeenCalledTimes(1);
    // After the middleware unwinds, no ambient context.
    expect(getTenantId()).toBeUndefined();
  });

  it('missing tenant header + rejectMissingTenant=true throws TenantValidationError', async () => {
    const m = buildTenantContextMiddleware();
    const next = vi.fn((): Promise<void> => Promise.resolve());
    await expect(m.hono(makeHonoCtx({ headers: {} }), next)).rejects.toBeInstanceOf(
      TenantValidationError,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('missing tenant header + rejectMissingTenant=false passes through with no context', async () => {
    const m = buildTenantContextMiddleware({ rejectMissingTenant: false });
    let observed: string | undefined = 'sentinel';
    const next = vi.fn((): Promise<void> => {
      observed = getTenantId();
      return Promise.resolve();
    });
    await m.hono(makeHonoCtx({ headers: {} }), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(observed).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Express adapter
// ─────────────────────────────────────────────────────────────────────

describe('Express adapter', () => {
  it('extracts from req.headers and runs next() inside withTenantContext', async () => {
    const m = buildTenantContextMiddleware();
    const next = vi.fn((err?: unknown) => {
      expect(err).toBeUndefined();
      expect(getTenantId()).toBe(TENANT_ID);
    });
    await m.express(
      makeExpressReq({ headers: { 'x-cortex-tenant-id': TENANT_ID } }),
      undefined,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('forwards extraction failure to next(err)', async () => {
    const m = buildTenantContextMiddleware();
    const next = vi.fn((_err?: unknown) => undefined);
    await m.express(makeExpressReq({ headers: {} }), undefined, next);
    expect(next).toHaveBeenCalledTimes(1);
    const errArg = next.mock.calls[0]?.[0];
    expect(errArg).toBeInstanceOf(TenantValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────
// validateTenant integration
// ─────────────────────────────────────────────────────────────────────

describe('validateTenant', () => {
  it('is invoked with the extracted tenantId; if it throws, request fails', async () => {
    const validate = vi.fn((id: string): Promise<void> => {
      if (id === TENANT_ID) {
        return Promise.reject(new Error('tenant suspended'));
      }
      return Promise.resolve();
    });
    const m = buildTenantContextMiddleware({ validateTenant: validate });
    const next = vi.fn((): Promise<void> => Promise.resolve());

    await expect(
      m.hono(makeHonoCtx({ headers: { 'x-cortex-tenant-id': TENANT_ID } }), next),
    ).rejects.toThrowError('tenant suspended');
    expect(validate).toHaveBeenCalledWith(TENANT_ID);
    expect(next).not.toHaveBeenCalled();
  });
});

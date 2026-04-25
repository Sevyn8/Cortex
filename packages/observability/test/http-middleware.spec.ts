import { describe, expect, it, vi } from 'vitest';
import { SpanKind, type Span, type Tracer } from '@opentelemetry/api';
import {
  buildObservabilityMiddleware,
  defaultCorrelationExtractor,
  type CorrelationExtractor,
} from '../src/http-middleware.js';
import { getCorrelationId } from '../src/correlation-context.js';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface HonoCtxOpts {
  headers?: Record<string, string>;
  method?: string;
  url?: string;
}

function makeHonoCtx(opts: HonoCtxOpts = {}): {
  req: { raw: { headers: Headers }; method: string; url: string };
  set: ReturnType<typeof vi.fn>;
} {
  return {
    req: {
      raw: { headers: new Headers(opts.headers ?? {}) },
      method: opts.method ?? 'GET',
      url: opts.url ?? 'http://localhost/api',
    },
    set: vi.fn(),
  };
}

interface ExpressReqOpts {
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  path?: string;
}

function makeExpressReq(opts: ExpressReqOpts = {}): {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  path: string;
} {
  return {
    headers: opts.headers ?? {},
    method: opts.method ?? 'GET',
    url: opts.url ?? '/api',
    path: opts.path ?? '/api',
  };
}

function makeMockTracer(): {
  tracer: Tracer;
  startSpanMock: ReturnType<typeof vi.fn>;
  endMock: ReturnType<typeof vi.fn>;
} {
  const endMock = vi.fn();
  const span = {
    end: endMock,
    spanContext: () => ({
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: 1,
      isRemote: false,
    }),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    updateName: vi.fn(),
    isRecording: () => true,
  } as unknown as Span;
  const startSpanMock = vi.fn(() => span);
  const tracer = {
    startSpan: startSpanMock,
    startActiveSpan: vi.fn(),
  } as unknown as Tracer;
  return { tracer, startSpanMock, endMock };
}

// ─────────────────────────────────────────────────────────────────────
// defaultCorrelationExtractor
// ─────────────────────────────────────────────────────────────────────

describe('defaultCorrelationExtractor', () => {
  it('reads x-correlation-id header in any casing', () => {
    expect(defaultCorrelationExtractor({ headers: { 'x-correlation-id': 'a' } })).toBe('a');
    expect(defaultCorrelationExtractor({ headers: { 'X-Correlation-Id': 'b' } })).toBe('b');
    expect(defaultCorrelationExtractor({ headers: { 'X-CORRELATION-ID': 'c' } })).toBe('c');
  });

  it('falls back to x-request-id when x-correlation-id is absent', () => {
    expect(defaultCorrelationExtractor({ headers: { 'x-request-id': 'fallback' } })).toBe(
      'fallback',
    );
  });

  it('returns undefined when neither header present and treats empty strings as absent', () => {
    expect(defaultCorrelationExtractor({ headers: {} })).toBeUndefined();
    expect(defaultCorrelationExtractor({ headers: { 'x-correlation-id': '' } })).toBeUndefined();
    expect(
      defaultCorrelationExtractor({
        headers: { 'x-correlation-id': '', 'x-request-id': 'fallback' },
      }),
    ).toBe('fallback');
  });
});

// ─────────────────────────────────────────────────────────────────────
// skipPaths
// ─────────────────────────────────────────────────────────────────────

describe('skipPaths', () => {
  it('bypasses extraction and binding for default health-check paths', async () => {
    const mw = buildObservabilityMiddleware({ moduleId: 'cortex-test' });
    let observed: string | undefined = 'sentinel';
    await mw.hono(
      makeHonoCtx({
        url: 'http://localhost/health',
        headers: { 'x-correlation-id': 'should-be-ignored' },
      }),
      () => {
        observed = getCorrelationId();
        return Promise.resolve();
      },
    );
    expect(observed).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Hono adapter
// ─────────────────────────────────────────────────────────────────────

describe('Hono adapter', () => {
  it('binds the extracted correlation_id; downstream getCorrelationId returns the inbound value', async () => {
    const mw = buildObservabilityMiddleware({ moduleId: 'cortex-test' });
    const ctx = makeHonoCtx({ headers: { 'x-correlation-id': 'inbound-id' } });
    let observed: string | undefined;
    await mw.hono(ctx, () => {
      observed = getCorrelationId();
      return Promise.resolve();
    });
    expect(observed).toBe('inbound-id');
    expect(ctx.set).toHaveBeenCalledWith('correlationId', 'inbound-id');
  });

  it('generateIfMissing=true (default) generates a UUID when no header present', async () => {
    const mw = buildObservabilityMiddleware({ moduleId: 'cortex-test' });
    let observed: string | undefined;
    await mw.hono(makeHonoCtx({}), () => {
      observed = getCorrelationId();
      return Promise.resolve();
    });
    expect(observed).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('generateIfMissing=false bypasses correlation context when no header present', async () => {
    const mw = buildObservabilityMiddleware({
      moduleId: 'cortex-test',
      generateIfMissing: false,
    });
    let observed: string | undefined = 'sentinel';
    await mw.hono(makeHonoCtx({}), () => {
      observed = getCorrelationId();
      return Promise.resolve();
    });
    expect(observed).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Express adapter
// ─────────────────────────────────────────────────────────────────────

describe('Express adapter', () => {
  it('binds the correlation_id, assigns req.correlationId, and runs next() inside the bound context', async () => {
    const mw = buildObservabilityMiddleware({ moduleId: 'cortex-test' });
    const req = makeExpressReq({ headers: { 'x-correlation-id': 'inbound' } });
    let observed: string | undefined;
    const next = vi.fn(() => {
      observed = getCorrelationId();
    });
    await mw.express(req, {}, next);
    expect(observed).toBe('inbound');
    const reqWithCorr = req as { correlationId?: string };
    expect(reqWithCorr.correlationId).toBe('inbound');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('forwards thrown errors via next(err) instead of rethrowing', async () => {
    const throwingExtractor: CorrelationExtractor = () => {
      throw new Error('bad input');
    };
    const mw = buildObservabilityMiddleware({
      moduleId: 'cortex-test',
      extractor: throwingExtractor,
    });
    const next = vi.fn();
    await expect(mw.express(makeExpressReq({}), {}, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Span attributes
// ─────────────────────────────────────────────────────────────────────

describe('span attributes', () => {
  it('startSpan is called with SERVER kind and http.method / http.target / cortex.correlation_id attributes', async () => {
    const { tracer, startSpanMock, endMock } = makeMockTracer();
    const mw = buildObservabilityMiddleware({ moduleId: 'cortex-test', tracer });
    await mw.hono(
      makeHonoCtx({
        headers: { 'x-correlation-id': 'fixed' },
        method: 'POST',
        url: 'http://localhost/foo',
      }),
      () => Promise.resolve(),
    );

    expect(startSpanMock).toHaveBeenCalledTimes(1);
    expect(startSpanMock).toHaveBeenCalledWith('POST /foo', {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': 'POST',
        'http.target': '/foo',
        'cortex.correlation_id': 'fixed',
      },
    });
    expect(endMock).toHaveBeenCalledTimes(1);
  });
});

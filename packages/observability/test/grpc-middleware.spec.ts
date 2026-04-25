import { describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { buildGrpcInterceptor, type GrpcMetadataLike } from '../src/grpc-middleware.js';
import { ObservabilityConfigError, ObservabilityValidationError } from '../src/errors.js';
import { getCorrelationId } from '../src/correlation-context.js';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeMetadata(
  entries: Record<string, string | string[] | undefined> = {},
): GrpcMetadataLike {
  return {
    get(key: string): string[] | string | undefined {
      return entries[key];
    },
  };
}

function makeMockTracer(): {
  tracer: Tracer;
  startSpanMock: ReturnType<typeof vi.fn>;
  span: {
    end: ReturnType<typeof vi.fn>;
    recordException: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
} {
  const span = {
    end: vi.fn(),
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
  };
  const startSpanMock = vi.fn(() => span as unknown as Span);
  const tracer = {
    startSpan: startSpanMock,
    startActiveSpan: vi.fn(),
  } as unknown as Tracer;
  return { tracer, startSpanMock, span };
}

const METHOD = '/cortex.foundation.v1.Tenants/Create';

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('buildGrpcInterceptor — validation', () => {
  it('throws ObservabilityConfigError with ObservabilityValidationError as cause when moduleId is invalid', () => {
    expect(() => buildGrpcInterceptor({ moduleId: 'INVALID_ID' })).toThrow(
      ObservabilityConfigError,
    );
    try {
      buildGrpcInterceptor({ moduleId: 'INVALID_ID' });
    } catch (err) {
      expect(err).toBeInstanceOf(ObservabilityConfigError);
      expect((err as ObservabilityConfigError).code).toBe('CONFIG_INVALID');
      expect((err as ObservabilityConfigError).cause).toBeInstanceOf(ObservabilityValidationError);
    }
  });
});

describe('correlation extraction from gRPC metadata', () => {
  it('reads x-correlation-id (string and array shapes), falls back to x-request-id, treats empty as absent', async () => {
    const interceptor = buildGrpcInterceptor({ moduleId: 'cortex-test' });
    const noGen = buildGrpcInterceptor({ moduleId: 'cortex-test', generateIfMissing: false });
    const observed: (string | undefined)[] = [];
    const handler = (): Promise<void> => {
      observed.push(getCorrelationId());
      return Promise.resolve();
    };

    await interceptor.wrap(
      { metadata: makeMetadata({ 'x-correlation-id': 'abc' }), method: METHOD },
      handler,
    );
    await interceptor.wrap(
      { metadata: makeMetadata({ 'x-correlation-id': ['first', 'second'] }), method: METHOD },
      handler,
    );
    await interceptor.wrap(
      { metadata: makeMetadata({ 'x-request-id': 'fallback' }), method: METHOD },
      handler,
    );
    await noGen.wrap(
      { metadata: makeMetadata({ 'x-correlation-id': '' }), method: METHOD },
      handler,
    );
    await noGen.wrap({ metadata: makeMetadata({}), method: METHOD }, handler);

    expect(observed[0]).toBe('abc');
    expect(observed[1]).toBe('first');
    expect(observed[2]).toBe('fallback');
    expect(observed[3]).toBeUndefined();
    expect(observed[4]).toBeUndefined();
  });
});

describe('wrap — happy path', () => {
  it('invokes handler with passed args and starts a SERVER span with rpc.* + cortex.correlation_id attributes', async () => {
    const { tracer, startSpanMock, span } = makeMockTracer();
    const interceptor = buildGrpcInterceptor({ moduleId: 'cortex-test', tracer });
    const handler = vi.fn(
      (a: string, b: number): Promise<string> => Promise.resolve(`${a}-${String(b)}`),
    );

    const result = await interceptor.wrap(
      { metadata: makeMetadata({ 'x-correlation-id': 'fixed' }), method: METHOD },
      handler,
      'hello',
      42,
    );

    expect(result).toBe('hello-42');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('hello', 42);
    expect(startSpanMock).toHaveBeenCalledWith(METHOD, {
      kind: SpanKind.SERVER,
      attributes: {
        'rpc.system': 'grpc',
        'rpc.service': 'cortex.foundation.v1.Tenants',
        'rpc.method': 'Create',
        'cortex.correlation_id': 'fixed',
      },
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

describe('wrap — generate when correlation absent', () => {
  it('default generateIfMissing=true binds a generated UUID for the handler scope', async () => {
    const interceptor = buildGrpcInterceptor({ moduleId: 'cortex-test' });
    let observed: string | undefined;
    const handler = (): Promise<void> => {
      observed = getCorrelationId();
      return Promise.resolve();
    };

    await interceptor.wrap({ metadata: makeMetadata({}), method: METHOD }, handler);

    expect(observed).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('wrap — error path', () => {
  it('rethrows handler errors after recordException + setStatus(ERROR) + end', async () => {
    const { tracer, span } = makeMockTracer();
    const interceptor = buildGrpcInterceptor({ moduleId: 'cortex-test', tracer });
    const error = new Error('handler boom');
    const handler = (): Promise<never> => Promise.reject(error);

    await expect(
      interceptor.wrap(
        { metadata: makeMetadata({ 'x-correlation-id': 'fixed' }), method: METHOD },
        handler,
      ),
    ).rejects.toBe(error);

    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

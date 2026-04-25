import { describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { buildPubSubWrapper, type PubSubMessageLike } from '../src/pubsub-wrapper.js';
import { ObservabilityConfigError } from '../src/errors.js';
import { getCorrelationId } from '../src/correlation-context.js';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeMessage(
  opts: {
    attributes?: Record<string, string>;
    messageId?: string;
  } = {},
): PubSubMessageLike {
  const msg: PubSubMessageLike = {
    attributes: opts.attributes ?? {},
  };
  if (opts.messageId !== undefined) {
    msg.messageId = opts.messageId;
  }
  return msg;
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

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('buildPubSubWrapper — validation', () => {
  it('throws ObservabilityConfigError when moduleId is invalid', () => {
    expect(() => buildPubSubWrapper({ moduleId: 'INVALID_ID', topicName: 'orders' })).toThrow(
      ObservabilityConfigError,
    );
  });

  it('throws ObservabilityConfigError when topicName is empty', () => {
    expect(() => buildPubSubWrapper({ moduleId: 'cortex-test', topicName: '' })).toThrow(
      ObservabilityConfigError,
    );
  });
});

describe('wrap — extract correlation from message attributes', () => {
  it('binds correlation_id from the message attribute for the handler scope', async () => {
    const wrapper = buildPubSubWrapper({ moduleId: 'cortex-test', topicName: 'orders' });
    let observed: string | undefined;
    await wrapper.wrap(
      makeMessage({ attributes: { correlation_id: 'attr-corr' } }),
      (): Promise<void> => {
        observed = getCorrelationId();
        return Promise.resolve();
      },
    );
    expect(observed).toBe('attr-corr');
  });
});

describe('wrap — generate when attribute missing', () => {
  it('default generateIfMissing=true generates a UUID and binds it', async () => {
    const wrapper = buildPubSubWrapper({ moduleId: 'cortex-test', topicName: 'orders' });
    let observed: string | undefined;
    await wrapper.wrap(makeMessage({ attributes: {} }), (): Promise<void> => {
      observed = getCorrelationId();
      return Promise.resolve();
    });
    expect(observed).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('wrap — span attributes', () => {
  it('starts a CONSUMER span "process <topic>" with messaging.* + cortex.correlation_id attributes', async () => {
    const { tracer, startSpanMock, span } = makeMockTracer();
    const wrapper = buildPubSubWrapper({
      moduleId: 'cortex-test',
      topicName: 'orders',
      subscriptionName: 'orders-sub',
      tracer,
    });

    await wrapper.wrap(
      makeMessage({
        attributes: { correlation_id: 'fixed' },
        messageId: 'mid-123',
      }),
      (): Promise<string> => Promise.resolve('ok'),
    );

    expect(startSpanMock).toHaveBeenCalledWith('process orders', {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'gcp_pubsub',
        'messaging.destination.name': 'orders',
        'messaging.consumer.group.name': 'orders-sub',
        'messaging.message.id': 'mid-123',
        'cortex.correlation_id': 'fixed',
      },
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

describe('wrap — error path', () => {
  it('rethrows handler errors after recordException + setStatus(ERROR) + end', async () => {
    const { tracer, span } = makeMockTracer();
    const wrapper = buildPubSubWrapper({
      moduleId: 'cortex-test',
      topicName: 'orders',
      tracer,
    });
    const error = new Error('handler boom');

    await expect(
      wrapper.wrap(
        makeMessage({ attributes: { correlation_id: 'fixed' } }),
        (): Promise<never> => Promise.reject(error),
      ),
    ).rejects.toBe(error);

    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

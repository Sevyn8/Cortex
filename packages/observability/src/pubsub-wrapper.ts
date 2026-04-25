/**
 * Cloud Pub/Sub message-handler wrapper for @cortex/observability.
 *
 * Each inbound message gets its own observability context: extract or
 * generate a `correlation_id`, open a CONSUMER-kind OTel span (per the
 * messaging semantic conventions), run the handler inside both the
 * correlation_id AsyncLocalStorage AND the OTel span context. Logs and
 * metrics emitted by the handler automatically inherit
 * `correlation_id`, `trace_id`, `span_id` for the span's lifetime.
 *
 * Framework-agnostic — accepts any object that quacks like a Pub/Sub
 * Message. No runtime import of `@google-cloud/pubsub`.
 *
 * Correlation extraction uses the `correlation_id` message attribute.
 * Pub/Sub attribute keys are flat snake_case by convention; we deliberately
 * do NOT prefix with `x-` (HTTP/gRPC convention) to match what publishers
 * write.
 *
 * Ack / nack remain the consumer's responsibility — the wrapper does not
 * manage delivery semantics. On thrown errors, the span captures the
 * failure (status ERROR + recorded exception) and rethrows; the caller
 * decides whether to ack-as-success (drop the message) or nack-for-retry.
 */

import { context, SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { ObservabilityConfigError, ObservabilityValidationError } from './errors.js';
import { generateCorrelationId, withCorrelationContext } from './correlation-context.js';
import { createTracer } from './tracer.js';
import { moduleId, type ModuleId } from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const PUBSUB_CORRELATION_ATTRIBUTE = 'correlation_id';

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Subset of a Pub/Sub `Message` object sufficient for context wrapping.
 * `data` and `publishTime` are typed for completeness but not consumed
 * by the wrapper itself.
 */
export interface PubSubMessageLike {
  attributes?: Record<string, string>;
  data?: Buffer | Uint8Array | string;
  messageId?: string;
  publishTime?: Date | string;
}

export interface PubSubWrapperOptions {
  /** Service identifier — slug per `moduleId(value)`. */
  moduleId: string;

  /** Topic the messages were published to. Used for span attributes. */
  topicName: string;

  /**
   * Subscription the consumer is attached to. Optional — when present,
   * surfaces in the span as `messaging.consumer.group.name`.
   */
  subscriptionName?: string;

  /**
   * If `true` (default), messages without a `correlation_id` attribute
   * get a fresh UUIDv4. If `false`, they pass through with no
   * correlation context bound.
   */
  generateIfMissing?: boolean;

  /**
   * Optional tracer override. Defaults to `createTracer({ moduleId })`.
   */
  tracer?: Tracer;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface PubSubMessageHandler<T = unknown> {
  wrap<TResult>(
    message: PubSubMessageLike,
    handler: (msg: PubSubMessageLike) => Promise<TResult>,
  ): Promise<TResult>;
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

interface ResolvedOptions {
  moduleId: ModuleId;
  topicName: string;
  subscriptionName: string | undefined;
  generateIfMissing: boolean;
  tracer: Tracer;
}

function resolveOptions(options: PubSubWrapperOptions): ResolvedOptions {
  let validatedModuleId: ModuleId;
  try {
    validatedModuleId = moduleId(options.moduleId);
  } catch (err) {
    if (err instanceof ObservabilityValidationError) {
      throw new ObservabilityConfigError(`Invalid moduleId: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }

  if (typeof options.topicName !== 'string' || options.topicName.length === 0) {
    throw new ObservabilityConfigError('topicName must be a non-empty string');
  }

  return {
    moduleId: validatedModuleId,
    topicName: options.topicName,
    subscriptionName: options.subscriptionName,
    generateIfMissing: options.generateIfMissing ?? true,
    tracer: options.tracer ?? createTracer({ moduleId: validatedModuleId }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a Pub/Sub message-handler wrapper. Consumers call `wrap(msg,
 * handler)` inside their subscription's message-event listener.
 *
 * @throws ObservabilityConfigError — invalid `moduleId` or empty `topicName`.
 */
export function buildPubSubWrapper(options: PubSubWrapperOptions): PubSubMessageHandler {
  const resolved = resolveOptions(options);

  return {
    async wrap<TResult>(
      message: PubSubMessageLike,
      handler: (msg: PubSubMessageLike) => Promise<TResult>,
    ): Promise<TResult> {
      const fromAttribute = message.attributes?.[PUBSUB_CORRELATION_ATTRIBUTE];
      let extracted: string | undefined =
        typeof fromAttribute === 'string' && fromAttribute.length > 0 ? fromAttribute : undefined;
      if (extracted === undefined) {
        if (!resolved.generateIfMissing) {
          return handler(message);
        }
        extracted = generateCorrelationId();
      }
      const correlationId = extracted;

      const span = resolved.tracer.startSpan(`process ${resolved.topicName}`, {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'gcp_pubsub',
          'messaging.destination.name': resolved.topicName,
          ...(resolved.subscriptionName !== undefined
            ? { 'messaging.consumer.group.name': resolved.subscriptionName }
            : {}),
          ...(message.messageId !== undefined ? { 'messaging.message.id': message.messageId } : {}),
          'cortex.correlation_id': correlationId,
        },
      });

      try {
        return await context.with(trace.setSpan(context.active(), span), async () => {
          return await withCorrelationContext(correlationId, async () => {
            return await handler(message);
          });
        });
      } catch (err) {
        if (err instanceof Error) {
          span.recordException(err);
        }
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  };
}

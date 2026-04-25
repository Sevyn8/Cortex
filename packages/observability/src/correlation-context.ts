/**
 * AsyncLocalStorage-backed correlation_id store for @cortex/observability.
 *
 * Single source of truth for "what correlation_id is bound to this
 * request?" Set by `buildObservabilityMiddleware` at request entry, read
 * by `defaultContextProvider.getCorrelationId` so every log line, metric
 * label, and span attribute emitted inside the request's async subtree
 * inherits it automatically — no manual threading required.
 *
 * Mirrors @cortex/tenant-context's AsyncLocalStorage pattern. Concurrent
 * requests are isolated by Node's async-hooks substrate; each
 * `withCorrelationContext(...)` call creates a new async scope visible
 * only to its awaited subtree.
 *
 * Validation is intentionally lenient: any non-empty string up to 256
 * characters. Upstream callers may use diverse ID formats (UUID, ksuid,
 * opaque W3C traceparent fragments, etc.); this package accepts whatever
 * arrives rather than forcing a single convention.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ObservabilityValidationError } from './errors.js';

export interface CorrelationContextSnapshot {
  correlationId: string;
}

const correlationStore = new AsyncLocalStorage<CorrelationContextSnapshot | undefined>();

const MAX_CORRELATION_ID_LENGTH = 256;

/**
 * Returns the correlation_id bound to the current async context, or
 * `undefined` if no context is set. Cheap — called on every log
 * emission and metric increment.
 */
export function getCorrelationId(): string | undefined {
  return correlationStore.getStore()?.correlationId;
}

/**
 * Runs `fn` within an async context bound to `correlationId`. Validates
 * the id is a non-empty string up to 256 characters before entering the
 * scope.
 *
 * @throws ObservabilityValidationError — empty, non-string, or oversized id
 */
export function withCorrelationContext<T>(
  correlationId: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    throw new ObservabilityValidationError('correlationId must be a non-empty string');
  }
  if (correlationId.length > MAX_CORRELATION_ID_LENGTH) {
    throw new ObservabilityValidationError(
      `correlationId must be ≤ ${String(MAX_CORRELATION_ID_LENGTH)} characters; got ${String(correlationId.length)}`,
    );
  }
  return correlationStore.run({ correlationId }, fn);
}

/**
 * Generate a fresh correlation_id (UUIDv4). Used by the middleware when
 * no upstream header is present and `generateIfMissing` is true.
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * @internal
 *
 * Test-only escape hatch returning the underlying `AsyncLocalStorage`
 * instance. Tests use this to introspect the store directly. NOT
 * exported from the package barrel — consumers must import via the file
 * path.
 */
export function __getCorrelationStoreForTesting(): AsyncLocalStorage<
  CorrelationContextSnapshot | undefined
> {
  return correlationStore;
}

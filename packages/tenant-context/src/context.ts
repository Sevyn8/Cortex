/**
 * AsyncLocalStorage-backed tenant context store for @cortex/tenant-context.
 *
 * Single source of truth for "what tenant am I currently operating as?"
 * Set by middleware (HTTP/gRPC/Pub/Sub) at request entry; read everywhere
 * downstream — DB session binding, audit emission, log enrichment.
 *
 * Concurrent requests are isolated by Node's async-hooks substrate: each
 * `withTenantContext(...)` call creates a new async scope visible only to
 * the awaited subtree.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { TenantContextMissingError, TenantValidationError } from './errors.js';
import type { TenantContextSnapshot } from './types.js';

const tenantIdSchema = z.string().uuid();

// The store value is `TenantContextSnapshot | undefined` so `withoutTenantContext`
// can run a nested scope with undefined as the active value without casting.
const contextStore = new AsyncLocalStorage<TenantContextSnapshot | undefined>();

/**
 * Returns the tenant id bound to the current async context, or `undefined`
 * if no context is set. Use this when the caller can handle a missing
 * context (e.g., control-plane operations); use `getTenantOrThrow` when
 * absence is a programmer error.
 */
export function getTenantId(): string | undefined {
  return contextStore.getStore()?.tenantId;
}

/**
 * Returns the tenant id bound to the current async context. Throws
 * `TenantContextMissingError` if no context is set.
 */
export function getTenantOrThrow(): string {
  const id = getTenantId();
  if (id === undefined) {
    throw new TenantContextMissingError();
  }
  return id;
}

/**
 * Runs `fn` within an async context bound to `tenantId`. The id is
 * validated as a UUID before the scope is entered. `fn` and any awaited
 * subtree see the bound tenant via `getTenantId` / `getTenantOrThrow`.
 *
 * Returns whatever `fn` returns (sync value or Promise — the caller's
 * choice; `AsyncLocalStorage.run` is transparent to either).
 *
 * @throws TenantValidationError if `tenantId` is not a valid UUID
 */
export function withTenantContext<T>(tenantId: string, fn: () => T | Promise<T>): T | Promise<T> {
  const parsed = tenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new TenantValidationError(`Invalid tenantId: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  const snapshot: TenantContextSnapshot = { tenantId: parsed.data };
  return contextStore.run(snapshot, fn);
}

/**
 * Runs `fn` in a nested async scope where the tenant context is
 * explicitly absent. Use for control-plane operations that must not
 * inherit any caller-side tenant binding (e.g., listing all tenants
 * across the registry).
 *
 * If called outside any outer context, this is a no-op; if called from
 * inside `withTenantContext`, the inner scope hides the outer binding for
 * the duration of `fn`.
 */
export function withoutTenantContext<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return contextStore.run(undefined, fn);
}

/**
 * @internal
 *
 * Test-only escape hatch returning the underlying `AsyncLocalStorage`
 * instance. Tests use this to introspect the store directly or to assert
 * that a scope did/didn't bleed across boundaries. NOT exported from the
 * package barrel — consumers must import via the file path.
 */
export function __getContextStoreForTesting(): AsyncLocalStorage<
  TenantContextSnapshot | undefined
> {
  return contextStore;
}

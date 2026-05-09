/**
 * F04 Slice C — consumer registry for `registerConfigConsumer` per
 * Q-NEW-F04C-6 (thin-wrapper over `registerNamespaceSchema`).
 *
 * Records per-consumer metadata that the resolver consults at
 * lookup time:
 *   - `defaultValue` — in-code default returned when no DB row
 *     exists at any tier (Q-NEW-F04C-2 third tier; necessary
 *     because F04 D14 substrate is per-tenant only and can't store
 *     cross-tenant defaults).
 *   - `ttl` — per-consumer cache TTL override (Q-NEW-F04C-3;
 *     defaults to 60s when omitted).
 *
 * **Logical namespace** (the registration arg) is the tier-naked
 * name — e.g., `'theme'`, `'scd'`, `'i18n'`. The resolver walks
 * `tenant.<logicalNs>` then `platform.<logicalNs>` literal namespaces
 * before falling through to `defaultValue`. This helper registers
 * the same Zod schema under BOTH literal namespaces so either tier's
 * row validates identically.
 *
 * Backward compat: `registerNamespaceSchema` (Slice A primitive)
 * remains available for callers who don't want the resolver/cache
 * machinery (e.g., F03 Slice C's `tenant.scd` registration; the
 * trigger reads via raw SQL, not via `getConfig`/`resolveConfig`).
 * Migration of existing direct callers is voluntary and operator-
 * deferred.
 */

import type { ZodType } from 'zod';
import { registerNamespaceSchema } from './schema-registry.js';

export const DEFAULT_CONSUMER_TTL_SECONDS = 60 as const;

export interface RegisterConfigConsumerParams<T> {
  /**
   * Logical namespace (tier-naked). The resolver internally walks
   * `tenant.<namespace>` and `platform.<namespace>` before falling
   * through to `defaultValue`.
   */
  namespace: string;
  /** Zod schema validated against rows at every tier. */
  schema: ZodType<T>;
  /** Pinned schema version — drafts/rows pin to this number. */
  schemaVersion: number;
  /**
   * In-code default returned when no DB row exists at any tier.
   * Q-NEW-F04C-2's third tier; necessary for cross-tenant defaults
   * (D14 substrate is per-tenant only).
   *
   * Pass `null` explicitly if the consumer wants null-on-no-row
   * rather than a default value.
   */
  defaultValue: T | null;
  /** Optional cache TTL override in seconds. Defaults to 60. */
  ttl?: number;
}

export interface ConsumerEntry<T = unknown> {
  namespace: string;
  schemaVersion: number;
  defaultValue: T | null;
  ttlSeconds: number;
}

const consumers = new Map<string, ConsumerEntry>();

/**
 * Register a consumer for the resolver. Side-effects:
 *   1. Registers the schema under `tenant.<namespace>` (idempotent
 *      if the same schema reference is already registered).
 *   2. Registers the schema under `platform.<namespace>` (idempotent).
 *   3. Records the consumer entry for resolver lookup.
 *
 * Top-level call pattern at consumer-module init — same shape as
 * `@cortex/audit-events`' `registerAuditActions` and the existing
 * `registerNamespaceSchema`.
 */
export function registerConfigConsumer<T>(
  params: RegisterConfigConsumerParams<T>,
): ConsumerEntry<T> {
  const ttlSeconds = params.ttl ?? DEFAULT_CONSUMER_TTL_SECONDS;
  // Register schema for both tiers. registerNamespaceSchema is
  // idempotent on same-reference re-registration; throws on
  // different-reference conflict.
  registerNamespaceSchema(`tenant.${params.namespace}`, params.schema, {
    version: params.schemaVersion,
  });
  registerNamespaceSchema(`platform.${params.namespace}`, params.schema, {
    version: params.schemaVersion,
  });

  const entry: ConsumerEntry<T> = {
    namespace: params.namespace,
    schemaVersion: params.schemaVersion,
    defaultValue: params.defaultValue,
    ttlSeconds,
  };
  consumers.set(params.namespace, entry as ConsumerEntry);
  return entry;
}

/**
 * Look up a consumer entry. Returns `undefined` if no consumer
 * registered for the namespace — resolver returns `null` in that
 * case (no default to fall back to).
 */
export function getConfigConsumer<T = unknown>(namespace: string): ConsumerEntry<T> | undefined {
  return consumers.get(namespace) as ConsumerEntry<T> | undefined;
}

/**
 * Test-only — clears the consumer registry. Production code should
 * never call this; the registry is meant to be append-only at
 * module init.
 */
export function resetConsumerRegistry(): void {
  consumers.clear();
}

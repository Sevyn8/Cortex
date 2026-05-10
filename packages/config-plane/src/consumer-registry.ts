/**
 * F04 Slice C / Slice D — consumer registry for `registerConfigConsumer`.
 *
 * Slice C (Q-NEW-F04C-6) introduced the registry as a thin wrapper
 * over `registerNamespaceSchema` recording resolver-relevant metadata:
 *   - `defaultValue` — in-code default returned when no DB row
 *     exists at any tier (Q-NEW-F04C-2 third tier; necessary
 *     because F04 D14 substrate is per-tenant only and can't store
 *     cross-tenant defaults).
 *   - `ttl` — per-consumer cache TTL override (Q-NEW-F04C-3;
 *     defaults to 60s when omitted).
 *
 * Slice D (Q-NEW-F04D-4) extends the registry IN-PLACE with optional
 * impact-relevant metadata for breaking-change detection:
 *   - `consumerModule` — which module / feature consumes this
 *     namespace. Surfaces in `ImpactReport.affected_consumers[].consumer_module`
 *     so a config author can see what they're about to break.
 *   - `breakingChangePolicy` — `'warn'` (default behavior; surfaces in
 *     warnings) or `'block'` (surfaces as a `policy_block` breaking
 *     change in the report; requires `confirmBreakingChanges: true`
 *     on `promoteDraft` to override).
 *   - `keyPaths` — sub-namespace key-paths the consumer cares about.
 *     When omitted, the consumer is namespace-level (any change touches
 *     it; over-blocks). When provided, impact is narrowed to changes
 *     intersecting these paths (Q-NEW-F04D-5).
 *
 * **Impact analysis is OPT-IN.** Consumers that omit the impact fields
 * still register schema + resolver-cache metadata but DO NOT participate
 * in impact reports. This is the intended posture per Q-NEW-F04D-4 —
 * consumers who care about breaking-change protection register the
 * metadata explicitly.
 *
 * **Logical namespace** (the registration arg) is the tier-naked
 * name — e.g., `'theme'`, `'scd'`, `'i18n'`. The resolver walks
 * `tenant.<logicalNs>` then `platform.<logicalNs>` literal namespaces
 * before falling through to `defaultValue`. This helper registers
 * the same Zod schema under BOTH literal namespaces so either tier's
 * row validates identically.
 *
 * Backward compat: `registerNamespaceSchema` (Slice A primitive)
 * remains available for callers who don't want the resolver/cache/
 * impact machinery (e.g., F03 Slice C's `tenant.scd` registration;
 * the trigger reads via raw SQL, not via `getConfig` /
 * `resolveConfig`). Such consumers are NOT in the impact-analysis
 * surface — that's the intended posture per Q-NEW-F04D-4. Migration
 * of existing direct callers to `registerConfigConsumer` is voluntary
 * and operator-deferred (tracked as a future-roadmap candidate for
 * `tenant.scd` if SCD-policy consumers ever want impact protection).
 */

import type { ZodType } from 'zod';
import { registerNamespaceSchema } from './schema-registry.js';

export const DEFAULT_CONSUMER_TTL_SECONDS = 60 as const;

/**
 * Breaking-change policy per consumer (Q-NEW-F04D-4 / D-2 axis 3):
 *   - `'warn'` (default if `consumerModule` provided) — impact-analysis
 *     surfaces this consumer in `affected_consumers` when changes
 *     intersect its keyPaths, but does NOT block promote on its own.
 *   - `'block'` — any change intersecting the consumer's keyPaths
 *     surfaces as a `policy_block` breaking change. Promote requires
 *     `confirmBreakingChanges: true` to override.
 */
export type BreakingChangePolicy = 'warn' | 'block';

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
  /**
   * Slice D impact-analysis metadata (OPT-IN). Identifies which
   * module / feature consumes this namespace. Surfaces in
   * `ImpactReport.affected_consumers[].consumer_module`. Consumers
   * that omit this field are not in the impact surface — they
   * still register schema + resolver-cache metadata, but
   * `analyzeImpact` skips them.
   */
  consumerModule?: string;
  /**
   * Slice D impact-analysis metadata (OPT-IN). Defaults to `'warn'`
   * if `consumerModule` is provided. Has no effect without
   * `consumerModule` (impact-skipped). See `BreakingChangePolicy`.
   */
  breakingChangePolicy?: BreakingChangePolicy;
  /**
   * Slice D impact-analysis metadata (OPT-IN; Q-NEW-F04D-5). Sub-
   * namespace key-paths the consumer cares about. When omitted but
   * `consumerModule` IS provided, the consumer is namespace-level
   * (any change to the namespace touches it). When provided, impact
   * is narrowed to changes intersecting these paths.
   *
   * Path syntax matches `dot-notation` JSON addressing — e.g.,
   * `'primary_color'`, `'palette.brand'`, `'sections.0.title'`.
   * Array indices are stringified; wildcards are NOT supported in
   * Phase 1 (deferred to first-consumer-driven).
   */
  keyPaths?: string[];
}

export interface ConsumerEntry<T = unknown> {
  namespace: string;
  schemaVersion: number;
  defaultValue: T | null;
  ttlSeconds: number;
  /** Slice D impact-analysis metadata. `undefined` ⇒ consumer is impact-skipped. */
  consumerModule?: string;
  /** Slice D impact-analysis metadata. Defaults to `'warn'` when `consumerModule` is set. */
  breakingChangePolicy?: BreakingChangePolicy;
  /** Slice D impact-analysis metadata. `undefined` OR `[]` ⇒ namespace-level. */
  keyPaths?: string[];
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

  // Slice D impact-analysis metadata. Per Q-NEW-F04D-4: opt-in.
  // When `consumerModule` is omitted, the consumer is impact-skipped
  // (the resolver still uses the entry; `analyzeImpact` ignores it).
  // When `consumerModule` is provided, default policy is `'warn'`.
  const entry: ConsumerEntry<T> = {
    namespace: params.namespace,
    schemaVersion: params.schemaVersion,
    defaultValue: params.defaultValue,
    ttlSeconds,
    ...(params.consumerModule !== undefined && {
      consumerModule: params.consumerModule,
      breakingChangePolicy: params.breakingChangePolicy ?? 'warn',
      ...(params.keyPaths !== undefined && { keyPaths: params.keyPaths }),
    }),
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
 * Slice D — list all impact-eligible consumers for a logical namespace.
 *
 * "Impact-eligible" means the consumer registered with
 * `consumerModule` set (per Q-NEW-F04D-4 opt-in posture). Consumers
 * registered without `consumerModule` are excluded.
 *
 * Phase 1 supports a single registered consumer per logical namespace
 * (the registry's underlying Map is keyed on namespace alone, so the
 * second `registerConfigConsumer` call for the same namespace
 * overwrites the first). Returning an array preserves API forward-
 * compat: when multi-consumer-per-namespace registration ships
 * (deferred until a first consumer needs it), this helper's signature
 * doesn't change. For Phase 1, the returned array has length 0 or 1.
 */
export function getImpactEligibleConsumers(namespace: string): ConsumerEntry[] {
  const entry = consumers.get(namespace);
  if (entry === undefined) return [];
  if (entry.consumerModule === undefined) return [];
  return [entry];
}

/**
 * Test-only — clears the consumer registry. Production code should
 * never call this; the registry is meant to be append-only at
 * module init.
 */
export function resetConsumerRegistry(): void {
  consumers.clear();
}

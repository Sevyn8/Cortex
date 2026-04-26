/**
 * Public types for `@cortex/quotas`.
 *
 * The package wraps `tenant_quota_usage` (Slice A migration 0007) with
 * a token-bucket interface. All values are `bigint` end-to-end per
 * planning-doc Decision 8 — Drizzle's `bigint` mode returns `BigInt`
 * for the underlying Postgres `bigint` columns; quota arithmetic stays
 * `BigInt`-native; conversion to `number` happens only at boundaries
 * that require it (HTTP `Retry-After` header, structured log fields
 * pino can't serialize cleanly).
 */

// ─────────────────────────────────────────────────────────────────────
// Resource classes (per F01 §6 + planning Decision 6)
// ─────────────────────────────────────────────────────────────────────

/**
 * The four canonical resource classes per F01 §6. The
 * `tenant_quota_usage.resource_class` column is free-form text in the
 * DB — these are the values `@cortex/quotas` understands. Future
 * resource classes can be added without migration.
 */
export const RESOURCE_CLASSES = [
  'api_calls_per_minute',
  'db_connections',
  'cpu_seconds',
  'ram_mb',
] as const;

export type ResourceClass = (typeof RESOURCE_CLASSES)[number];

// ─────────────────────────────────────────────────────────────────────
// Tier discriminator (mirrors `tenant.tier` column from migration 0007)
// ─────────────────────────────────────────────────────────────────────

/**
 * Tenant commercial tier. Mirrors the CHECK constraint on
 * `tenant.tier` from migration 0007. STANDARD tenants share Cloud Run
 * services + apply per-tier quota defaults; ENTERPRISE tenants get
 * dedicated services (per ADR-COMPUTE-001) + higher per-tier defaults.
 *
 * F02 will introduce per-tenant overrides via
 * `tenant_config_version.config_json.quotas[resource_class]`; until
 * then `@cortex/quotas` reads from `DEFAULT_TIER_QUOTAS` below.
 */
export type QuotaTier = 'STANDARD' | 'ENTERPRISE';

// ─────────────────────────────────────────────────────────────────────
// Windowing strategy
// ─────────────────────────────────────────────────────────────────────

/**
 * Window-alignment strategy for a resource class. The `tenant_quota_usage`
 * row keys on `(tenant_id, resource_class, window_start)`; `checkQuota`
 * computes `window_start` per the resource class's alignment.
 *
 *   - 'minute' alignment: `date_trunc('minute', now())` — used for
 *     `api_calls_per_minute` (1-minute rolling).
 *   - 'hour' alignment: `date_trunc('hour', now())` — used for
 *     `cpu_seconds` and `ram_mb` (1-hour rolling, matches typical
 *     billing-window granularity).
 *   - `db_connections` is point-in-time (current concurrent count),
 *     window-aligned to minute for bookkeeping but not a true rolling
 *     counter — a future revision may treat it differently.
 */
export type WindowAlignment = 'minute' | 'hour';

export interface QuotaWindow {
  readonly resourceClass: ResourceClass;
  readonly durationSeconds: number;
  readonly alignment: WindowAlignment;
}

/**
 * Per-resource-class window strategy. `checkQuota` consults this to
 * compute `window_start` for the `tenant_quota_usage` upsert.
 */
export const WINDOW_BY_RESOURCE_CLASS: Readonly<Record<ResourceClass, QuotaWindow>> = {
  api_calls_per_minute: {
    resourceClass: 'api_calls_per_minute',
    durationSeconds: 60,
    alignment: 'minute',
  },
  db_connections: { resourceClass: 'db_connections', durationSeconds: 60, alignment: 'minute' },
  cpu_seconds: { resourceClass: 'cpu_seconds', durationSeconds: 3600, alignment: 'hour' },
  ram_mb: { resourceClass: 'ram_mb', durationSeconds: 3600, alignment: 'hour' },
} as const;

// ─────────────────────────────────────────────────────────────────────
// Per-tier defaults (planning-doc Decision 7)
// ─────────────────────────────────────────────────────────────────────

/**
 * Sane starting baselines per planning-doc Decision 7. NOT load-derived;
 * the convention doc (sub-phase 8) flags these as TUNABLE via the F02
 * swap path (`tenant_config_version.config_json.quotas[resource_class]`)
 * — NOT by widening these defaults. The "everyone bumps the default
 * when they see 429s" failure mode is the explicit thing to avoid.
 *
 * Defaults exist as a floor, not a target.
 */
export const DEFAULT_TIER_QUOTAS: Readonly<
  Record<QuotaTier, Readonly<Record<ResourceClass, bigint>>>
> = {
  STANDARD: {
    api_calls_per_minute: 600n,
    db_connections: 10n,
    cpu_seconds: 3600n,
    ram_mb: 2048n,
  },
  ENTERPRISE: {
    api_calls_per_minute: 6000n,
    db_connections: 100n,
    cpu_seconds: 14400n,
    ram_mb: 8192n,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────
// Caller surface
// ─────────────────────────────────────────────────────────────────────

/**
 * Caller input to `checkQuota`.
 */
export interface CheckQuotaParams {
  /** Tenant id (UUID). RLS context MUST be bound before the check. */
  tenantId: string;

  /** Which resource class to check. Must be one of `RESOURCE_CLASSES`. */
  resourceClass: ResourceClass;

  /**
   * Amount to consume from the bucket. For per-call resources
   * (`api_calls_per_minute`), 1n. For accumulating resources
   * (`cpu_seconds`, `ram_mb`), the consumed amount in the resource's
   * native unit (seconds, MB-seconds). MUST be non-negative.
   */
  increment: bigint;
}

/**
 * Result of a quota check. Discriminated union on `allowed`.
 *
 * The library NEVER throws `QuotaExceededError` on quota exceedance —
 * it returns `{ allowed: false, ... }`. This is intentional: throwing
 * inside a caller's transaction would cause the caller's framework
 * (drizzle's `db.transaction`, etc.) to roll back the audit emission
 * AND the `tenant_quota_usage` upsert that just happened. Per
 * planning-doc Decision 9, every 429 MUST emit its own audit event;
 * that requires the audit row to commit, which requires no throw.
 *
 * Callers who want throw-semantics (e.g., worker processes bubbling
 * to a retry framework) construct `QuotaExceededError` manually from
 * the result:
 *
 * ```ts
 * const result = await checkQuota(db, params, opts);
 * if (!result.allowed) {
 *   throw new QuotaExceededError(`...`, {
 *     currentValue: result.currentValue,
 *     quotaLimit: result.quotaLimit,
 *     retryAfterSeconds: result.retryAfterSeconds,
 *   });
 * }
 * ```
 *
 * The HTTP middleware (sub-phase 4) consumes the result directly and
 * issues 429 + Retry-After without any throw round-trip.
 *
 * `bigint` fields stay native; conversion to `number` happens at the
 * HTTP-header / log-emission boundary (planning-doc Decision 8).
 */
export type CheckQuotaResult =
  | {
      readonly allowed: true;
      readonly currentValue: bigint;
      readonly quotaLimit: bigint;
      /** `null` on the allowed branch — no retry suggestion on success. */
      readonly retryAfterSeconds: null;
      /** ISO-8601 UTC string for the window the row was bucketed into. */
      readonly windowStart: string;
    }
  | {
      readonly allowed: false;
      readonly currentValue: bigint;
      readonly quotaLimit: bigint;
      /** Seconds until the current window rolls; HTTP `Retry-After` value. */
      readonly retryAfterSeconds: number;
      readonly windowStart: string;
      /** Surfaced for callers logging the rejection reason without re-examining params. */
      readonly resourceClass: ResourceClass;
    };

/**
 * Per-tier-and-class quota config. Returned by `getQuotaConfig(tier,
 * resourceClass)` at sub-phase 4. Slice C: derived from
 * `DEFAULT_TIER_QUOTAS`. F02: derived from
 * `tenant_config_version.config_json.quotas[resource_class]` with
 * fallback to `DEFAULT_TIER_QUOTAS`.
 */
export interface QuotaConfig {
  readonly tier: QuotaTier;
  readonly resourceClass: ResourceClass;
  readonly quotaLimit: bigint;
  readonly window: QuotaWindow;
}

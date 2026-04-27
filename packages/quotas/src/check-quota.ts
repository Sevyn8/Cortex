/**
 * Token-bucket quota enforcement for `@cortex/quotas`.
 *
 * Wraps the `tenant_quota_usage` substrate (Slice A migration 0007)
 * with an atomic upsert under tenant-bound RLS, plus `QUOTA_EXCEEDED`
 * audit emission via `@cortex/audit-events`. Hybrid DI factory +
 * module-scope default + test escapes mirroring `@cortex/encryption`.
 *
 * Caller contract (mirrors `@cortex/audit-events/src/emit.ts` +
 * `@cortex/encryption/src/encrypt.ts`):
 *
 *   - Caller MUST have bound a tenant id to the DB session via
 *     `bindTenantToDbSession` BEFORE calling. `tenant_quota_usage` RLS
 *     denies the upsert without it (SQLSTATE 42501); audit emission
 *     fails for the same reason.
 *
 *   - Caller MUST be inside an open transaction. The session binding
 *     is transaction-scoped; the audit row + the quota upsert must
 *     commit / roll back atomically with the source operation.
 *
 *   - DO NOT supply `occurred_at` to the audit emission — `@cortex/audit-events`
 *     auto-stamps `clock_timestamp()` per Decision 11.
 *
 *   - `BigInt` at the API boundary: the `CheckQuotaResult` carries
 *     `bigint` for `currentValue` / `quotaLimit`. The caller must
 *     `String(value)` (or convert to a safe `Number` if bounded) when
 *     constructing JSON responses or pino log fields. Sub-phase 4's
 *     middleware adapter does this at the 429 response boundary; this
 *     function records bigint values as strings inside the audit
 *     `after_state` for the same reason.
 *
 * The action catalog lives in `./catalog.ts` — a side-effect-free
 * re-export module so test files using `vi.mock('./check-quota.js')`
 * don't trip over the top-level `registerAuditActions(...)` call. Same
 * split pattern as `@cortex/encryption/src/catalog.ts` and
 * `@cortex/tenant-context/src/audit-actions.ts`.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { emitAuditEvent, getActionByName } from '@cortex/audit-events';
import { QUOTA_AUDIT_ACTIONS } from './catalog.js';
import { QuotaConfigError, QuotaExecutionError, QuotaValidationError } from './errors.js';
import { checkQuotaParamsSchema, quotaTierSchema } from './schemas.js';
import {
  DEFAULT_TIER_QUOTAS,
  WINDOW_BY_RESOURCE_CLASS,
  type CheckQuotaParams,
  type CheckQuotaResult,
  type QuotaTier,
  type WindowAlignment,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export interface CheckQuotaCallOptions {
  /**
   * Tenant tier — selects the per-tier quota default unless
   * `quotaLimit` is supplied. Must match the tenant's `tier` column;
   * caller resolves before calling (via `tenants.get(db, tenantId)`).
   */
  tier: QuotaTier;
  /**
   * Optional explicit limit override. When supplied, takes precedence
   * over `DEFAULT_TIER_QUOTAS[tier][resourceClass]`. F02 will use this
   * to thread per-tenant overrides from
   * `tenant_config_version.config_json.quotas[resource_class]`.
   */
  quotaLimit?: bigint;
}

export interface CheckQuota {
  check(
    db: NodePgDatabase<Record<string, never>>,
    params: CheckQuotaParams,
    opts: CheckQuotaCallOptions,
  ): Promise<CheckQuotaResult>;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (file-private)
// ─────────────────────────────────────────────────────────────────────

const VALID_ALIGNMENTS: ReadonlySet<WindowAlignment> = new Set(['minute', 'hour']);

/**
 * Compute window-end as ISO-8601 UTC, given a window-start ISO string
 * and the duration. Used to derive `retryAfterSeconds`.
 */
function windowEndIso(windowStartIso: string, durationSeconds: number): string {
  const startMs = new Date(windowStartIso).getTime();
  return new Date(startMs + durationSeconds * 1000).toISOString();
}

/**
 * Compute `Retry-After` seconds: ceil((windowEnd - now) / 1000).
 * Bounded to >= 1 (a 0-second Retry-After is a misleading hint —
 * minimum suggestion is "wait 1 second and try again").
 */
function retryAfterFromWindow(windowEndIso: string): number {
  const nowMs = Date.now();
  const endMs = new Date(windowEndIso).getTime();
  const seconds = Math.ceil((endMs - nowMs) / 1000);
  return Math.max(1, seconds);
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Construct a `CheckQuota` instance. Prefer this factory for new code;
 * legacy / convention callers continue to use the module-scope
 * `checkQuota` convenience export.
 *
 * Per planning-doc §4.16 cleanup vector (sub-phase 6.2, 2026-04-27):
 * the previous `opts.logger` field + dynamic-import logger plumbing
 * was removed as dead code. The cycle-defensive pattern that
 * motivated the lazy-logger shape is gone (resolved by §4.13 / commit
 * `ebb14ca`); no real WARN-level emit site exists in `@cortex/quotas`
 * today. If a future feature wants structured logging here, add it
 * with a static `import { createLogger } from '@cortex/observability'`
 * — the cycle topology supports static imports now.
 */
export function createQuotaChecker(): CheckQuota {
  return {
    async check(db, params, callOpts) {
      // 1. Validate params.
      const parsed = checkQuotaParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new QuotaValidationError(`Invalid checkQuota params: ${parsed.error.message}`, {
          cause: parsed.error,
        });
      }
      const data = parsed.data;

      // 2. Validate tier (ConfigError, not ValidationError — tier comes
      //    from the caller-side config / tenant lookup, not from a
      //    request body, so the failure mode is a config / programming
      //    error, not user-input invalidation).
      const parsedTier = quotaTierSchema.safeParse(callOpts.tier);
      if (!parsedTier.success) {
        throw new QuotaConfigError(`Invalid tier: ${parsedTier.error.message}`, {
          cause: parsedTier.error,
        });
      }

      // 3. Resolve quota limit: explicit > per-tier default.
      const quotaLimit =
        callOpts.quotaLimit ?? DEFAULT_TIER_QUOTAS[parsedTier.data][data.resourceClass];

      // 4. Window alignment (validated against allow-list — paranoia
      //    guard against future enum drift slipping into a SQL string).
      const window = WINDOW_BY_RESOURCE_CLASS[data.resourceClass];
      if (!VALID_ALIGNMENTS.has(window.alignment)) {
        throw new QuotaConfigError(
          `Unknown window alignment '${window.alignment}' for resource class '${data.resourceClass}'`,
        );
      }
      // sql.raw is safe here because alignment is a const-string from
      // the WINDOW_BY_RESOURCE_CLASS table, gated by the allow-list
      // above. If a future contributor adds a new alignment, the
      // allow-list catches it before the SQL is ever issued.
      const alignmentSql = sql.raw(`'${window.alignment}'`);

      // 5. Atomic upsert. Single SQL statement; Postgres takes a
      //    row-level lock on the conflicting row before applying the
      //    UPDATE. RETURNING gives us the post-increment value.
      //
      //    pg returns bigint columns as strings by default (driver
      //    doesn't auto-parse to BigInt without a custom type parser);
      //    we coerce at the boundary below.
      let row: { current_value: string; quota_limit: string; window_start: Date };
      try {
        const result = await db.execute<{
          current_value: string;
          quota_limit: string;
          window_start: Date;
        }>(sql`
          INSERT INTO tenant_quota_usage (
            tenant_id,
            resource_class,
            current_value,
            quota_limit,
            window_start,
            updated_at
          ) VALUES (
            ${data.tenantId},
            ${data.resourceClass},
            ${data.increment.toString()}::bigint,
            ${quotaLimit.toString()}::bigint,
            date_trunc(${alignmentSql}, clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            clock_timestamp()
          )
          ON CONFLICT (tenant_id, resource_class, window_start)
          DO UPDATE SET
            current_value = tenant_quota_usage.current_value + EXCLUDED.current_value,
            updated_at = clock_timestamp()
          RETURNING current_value, quota_limit, window_start
        `);
        const first = result.rows[0];
        if (first === undefined) {
          throw new QuotaExecutionError('tenant_quota_usage upsert returned no row (unexpected)');
        }
        row = first;
      } catch (err) {
        if (err instanceof QuotaExecutionError) throw err;
        throw classifyExecutionError(err);
      }

      // 6. Coerce bigint columns from pg's default-string return shape.
      //    `window_start` may come back as a `Date` (default pg type
      //    parser for OID 1184) OR as a string (some drizzle paths)
      //    depending on driver/parser config — coerce both safely.
      const currentValue = BigInt(row.current_value);
      const limitFromDb = BigInt(row.quota_limit);
      const ws: unknown = row.window_start;
      const windowStartIso =
        ws instanceof Date ? ws.toISOString() : new Date(String(ws)).toISOString();
      const wEndIso = windowEndIso(windowStartIso, window.durationSeconds);

      // 7. Decide allowed / exceeded. The post-increment value is
      //    compared against the limit — strictly greater is "over" so
      //    that a check that lands exactly at the limit is allowed
      //    (e.g., 600th request in a 600-cap window passes; 601st is
      //    rejected).
      if (currentValue > limitFromDb) {
        const retryAfterSeconds = retryAfterFromWindow(wEndIso);

        // 8. Emit QUOTA_EXCEEDED audit event. Verb: REJECT (the
        //    request is being rejected); per ADR-AU-001 Decision 3,
        //    REJECT allows optional before/after_state. We supply
        //    after_state for forensic visibility — auditors want to
        //    see "what was the count when we rejected".
        //
        //    BigInt → String conversion at the audit-payload boundary:
        //    JSON.stringify and pino's default serializer don't
        //    handle bigint. Convention doc (sub-phase 8) enumerates
        //    this gotcha workspace-wide.
        //
        //    NOTE: this happens INSIDE the caller's transaction. The
        //    library does NOT throw QuotaExceededError on the rejection
        //    path — throwing would cause drizzle's `db.transaction`
        //    wrapper to roll back the audit row (and the upsert) along
        //    with the caller's source operation. Returning instead
        //    lets the audit emission commit with the caller's tx.
        //    Callers who want throw-semantics convert manually:
        //
        //        const r = await checkQuota(...);
        //        if (!r.allowed) throw new QuotaExceededError(...);
        //
        //    See `CheckQuotaResult` JSDoc in `./types.ts`.
        await emitAuditEvent(db, {
          tenantId: data.tenantId,
          actorType: 'service',
          actorId: 'cortex-quotas',
          action: getActionByName(QUOTA_AUDIT_ACTIONS, 'QUOTA_EXCEEDED'),
          verb: 'REJECT',
          resource: `quota:${data.tenantId}:${data.resourceClass}`,
          after_state: {
            resource_class: data.resourceClass,
            current_value: currentValue.toString(),
            quota_limit: limitFromDb.toString(),
            increment: data.increment.toString(),
            window_start: windowStartIso,
            window_end: wEndIso,
            retry_after_seconds: retryAfterSeconds,
          },
        });

        return {
          allowed: false,
          currentValue,
          quotaLimit: limitFromDb,
          retryAfterSeconds,
          windowStart: windowStartIso,
          resourceClass: data.resourceClass,
        };
      }

      return {
        allowed: true,
        currentValue,
        quotaLimit: limitFromDb,
        retryAfterSeconds: null,
        windowStart: windowStartIso,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────

function classifyExecutionError(err: unknown): QuotaExecutionError {
  const code = (err as { code?: unknown }).code;
  const cause = err instanceof Error ? err : undefined;

  if (code === '42501') {
    return new QuotaExecutionError(
      'tenant_quota_usage upsert denied (SQLSTATE 42501). RLS rejected — ' +
        'verify the tenant id is bound to the DB session via ' +
        'bindTenantToDbSession before calling checkQuota.',
      cause === undefined ? undefined : { cause },
    );
  }
  if (code === '23514') {
    return new QuotaExecutionError(
      'tenant_quota_usage upsert failed CHECK constraint (SQLSTATE 23514).',
      cause === undefined ? undefined : { cause },
    );
  }
  const message =
    cause !== undefined
      ? `tenant_quota_usage upsert failed: ${cause.message}`
      : 'tenant_quota_usage upsert failed';
  return new QuotaExecutionError(message, cause === undefined ? undefined : { cause });
}

// ─────────────────────────────────────────────────────────────────────
// Module-scope default + convenience export + test escape hatches
// ─────────────────────────────────────────────────────────────────────

let defaultChecker: CheckQuota = createQuotaChecker();

/**
 * Convenience export for the canonical quota-check path. Backed by
 * the module-scope default checker.
 *
 * Caller MUST be inside an open transaction with `app.tenant_id`
 * bound (RLS prerequisite for both the `tenant_quota_usage` upsert
 * AND the `QUOTA_EXCEEDED` audit row INSERT).
 *
 * @returns CheckQuotaResult — discriminated on `allowed`. Callers MUST
 *   inspect `allowed` and respond accordingly. The library does NOT
 *   throw on quota exceedance; the audit emission for QUOTA_EXCEEDED
 *   happens inside the caller's transaction and commits with it. See
 *   `CheckQuotaResult` JSDoc in `./types.ts` for the full rationale.
 *
 * @throws QuotaValidationError — params fail zod schema
 * @throws QuotaConfigError — invalid tier / unknown resource class
 * @throws QuotaExecutionError — DB upsert failure (RLS denial 42501,
 *   driver error, etc.)
 * @throws AuditEventEmissionError — audit row INSERT failure on the
 *   exceed path (audit_event RLS / driver)
 */
export async function checkQuota(
  db: NodePgDatabase<Record<string, never>>,
  params: CheckQuotaParams,
  opts: CheckQuotaCallOptions,
): Promise<CheckQuotaResult> {
  return defaultChecker.check(db, params, opts);
}

/**
 * @internal
 *
 * Test-only escape: swap the module-scope default checker. Pair with
 * `__resetForTesting()` in `afterEach` to restore between tests.
 * Mirrors the convention in `@cortex/encryption`,
 * `@cortex/audit-events`, etc.
 */
export function __setCheckerForTesting(checker: CheckQuota): void {
  defaultChecker = checker;
}

/**
 * @internal
 *
 * Restore the production default checker (logger built lazily from
 * `createLogger({ moduleId: 'cortex-quotas' })`).
 */
export function __resetForTesting(): void {
  defaultChecker = createQuotaChecker();
}

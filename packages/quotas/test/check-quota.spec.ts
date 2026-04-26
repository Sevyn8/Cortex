/**
 * Integration tests for `@cortex/quotas`.
 *
 * Real DB (p09-repro) for `tenant_quota_usage` upsert + chain trigger
 * on `audit_event` + RLS enforcement. No KMS / no fakery — the token
 * bucket is pure SQL + audit emission, exercised end-to-end.
 *
 * Mirrors `packages/encryption/test/encrypt.spec.ts` setup convention.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { bindTenantToDbSession } from '@cortex/tenant-context';
import {
  DEFAULT_TIER_QUOTAS,
  QuotaExecutionError,
  QuotaValidationError,
  __resetForTesting,
  __setCheckerForTesting,
  checkQuota,
  createQuotaChecker,
  type CheckQuota,
  type CheckQuotaResult,
} from '../src/index.js';

let pool: Pool;
let db: NodePgDatabase<Record<string, never>>;
const createdTenants: string[] = [];

beforeAll(async () => {
  pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? 'test_user',
    password: process.env.PGPASSWORD ?? 'testpw',
    database: process.env.PGDATABASE ?? 'cortex',
  });
  db = drizzle(pool);
  // audit_event is owned by test_user in p09-repro (per ci.yaml); without
  // FORCE the owner bypasses RLS, silently passing the unbound-call denial
  // test. tenant_quota_usage is owned by postgres, so test_user is naturally
  // subject to RLS without FORCE — no toggle needed for that table.
  await pool.query('ALTER TABLE audit_event FORCE ROW LEVEL SECURITY');
});

afterAll(async () => {
  // Cleanup order: tenant_quota_usage rows first (under tenant binding,
  // RLS-protected) then tenant rows (no RLS, FK is ON DELETE RESTRICT
  // so children must go first). audit_event rows accumulate across runs
  // (append-only); they are not cleaned. tenant_kms_key rows are NOT
  // present here (we don't go through tenants.create which provisions
  // them — we INSERT raw tenant rows for this test suite).
  for (const id of createdTenants) {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        await client.query('DELETE FROM tenant_quota_usage WHERE tenant_id = $1', [id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch {
      // tenant may not have child rows; ignore.
    }
    await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
  }
  await pool.end();
});

/**
 * Create a tenant row and track it for afterAll cleanup. Returns the
 * UUID. Called by each test that needs a tenant_quota_usage row (the
 * FK on tenant_id requires the tenant to exist first).
 */
async function createTestTenant(): Promise<string> {
  const newId = randomUUID();
  await pool.query(
    `INSERT INTO tenant (id, external_id, display_name, tier)
       VALUES ($1, $2, 'Quota Test', 'STANDARD')`,
    [newId, `quota-test-${newId.slice(0, 8)}`],
  );
  createdTenants.push(newId);
  return newId;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

type AuditRow = {
  action: string;
  resource: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  prev_hash: Buffer | null;
  curr_hash: Buffer;
} & Record<string, unknown>;

async function fetchAuditRows(tenantId: string): Promise<AuditRow[]> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    const r = await tx.execute<AuditRow>(sql`
      SELECT action, resource, occurred_at, payload, prev_hash, curr_hash
      FROM audit_event
      WHERE tenant_id = ${tenantId}
      ORDER BY occurred_at ASC, ctid ASC
    `);
    return r.rows;
  });
}

type QuotaRow = { current_value: string; window_start: Date } & Record<string, unknown>;

async function fetchQuotaRows(tenantId: string): Promise<QuotaRow[]> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    const r = await tx.execute<QuotaRow>(sql`
      SELECT current_value, window_start
      FROM tenant_quota_usage
      WHERE tenant_id = ${tenantId}
      ORDER BY window_start ASC
    `);
    return r.rows;
  });
}

/**
 * Run a quota check inside a tenant-bound transaction. Sweetens the
 * boilerplate of `db.transaction(async (tx) => { bind; checkQuota; })`.
 */
async function checkUnderTenant(
  tenantId: string,
  resourceClass: 'api_calls_per_minute' | 'db_connections' | 'cpu_seconds' | 'ram_mb',
  increment: bigint,
  quotaLimit?: bigint,
): Promise<CheckQuotaResult> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    return checkQuota(
      tx,
      { tenantId, resourceClass, increment },
      quotaLimit !== undefined ? { tier: 'STANDARD', quotaLimit } : { tier: 'STANDARD' },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// Group: checkQuota happy path
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — happy path', () => {
  it('first request under limit returns allowed=true with bigint counters', async () => {
    const tenantId = await createTestTenant();
    const result = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);

    expect(result.allowed).toBe(true);
    expect(typeof result.currentValue).toBe('bigint');
    expect(result.currentValue).toBe(1n);
    expect(result.quotaLimit).toBe(DEFAULT_TIER_QUOTAS.STANDARD.api_calls_per_minute);
    expect(result.retryAfterSeconds).toBeNull();
    // ISO-8601 with milliseconds: 'YYYY-MM-DDTHH:mm:ss.sssZ'
    expect(result.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('multiple requests accumulate within the same window', async () => {
    const tenantId = await createTestTenant();
    const r1 = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
    const r2 = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
    const r3 = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);

    expect(r1.currentValue).toBe(1n);
    expect(r2.currentValue).toBe(2n);
    expect(r3.currentValue).toBe(3n);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });

  it('increment > 1 accumulates correctly', async () => {
    const tenantId = await createTestTenant();
    const r1 = await checkUnderTenant(tenantId, 'cpu_seconds', 10n);
    const r2 = await checkUnderTenant(tenantId, 'cpu_seconds', 5n);

    expect(r1.currentValue).toBe(10n);
    expect(r2.currentValue).toBe(15n);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: at-limit boundary (strict-greater rejection)
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — at-limit boundary', () => {
  it('request landing exactly AT the limit passes (strict-greater rejection)', async () => {
    const tenantId = await createTestTenant();
    // Pre-populate to 599n via a single big increment
    await checkUnderTenant(tenantId, 'api_calls_per_minute', 599n);
    // The 600th request lands at the limit exactly — should pass
    const result = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
    expect(result.allowed).toBe(true);
    expect(result.currentValue).toBe(600n);
    expect(result.quotaLimit).toBe(600n);
  });

  it('request that pushes OVER limit returns allowed=false with rejection details', async () => {
    const tenantId = await createTestTenant();
    // Push exactly to the limit (allowed)
    await checkUnderTenant(tenantId, 'api_calls_per_minute', 600n);

    // The library returns { allowed: false, ... } on exceedance — no
    // throw. Throwing inside the caller's tx would roll back the audit
    // row that just emitted (see CheckQuotaResult JSDoc).
    const result = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.currentValue).toBe(601n);
      expect(result.quotaLimit).toBe(600n);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.resourceClass).toBe('api_calls_per_minute');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: BigInt round-trip integration (follow-up #3 guard)
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — BigInt round-trip across pg boundary', () => {
  it('large bigint increment exceeding Number.MAX_SAFE_INTEGER preserves precision', async () => {
    const tenantId = await createTestTenant();
    // 2^60 = 1_152_921_504_606_846_976n — well above MAX_SAFE_INTEGER (2^53).
    const bigIncrement = 1n << 60n;
    const bigLimit = 1n << 62n;
    expect(bigIncrement).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const result = await checkUnderTenant(tenantId, 'cpu_seconds', bigIncrement, bigLimit);
    expect(result.currentValue).toBe(bigIncrement); // exact equality, no precision loss
    expect(result.quotaLimit).toBe(bigLimit);
    expect(result.allowed).toBe(true);

    // Round-trip via DB read confirms the upsert + return path preserves
    // precision through pg's string serialization + BigInt() coercion.
    const rows = await fetchQuotaRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0]!.current_value)).toBe(bigIncrement);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: cross-tenant isolation
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — cross-tenant isolation (RLS)', () => {
  it("tenant B's counter starts independently of tenant A's", async () => {
    const tenantA = await createTestTenant();
    const tenantB = await createTestTenant();

    // Tenant A accumulates to 100n
    await checkUnderTenant(tenantA, 'api_calls_per_minute', 100n);

    // Tenant B's first call should land at 1n (their own counter), not 101n
    const bResult = await checkUnderTenant(tenantB, 'api_calls_per_minute', 1n);
    expect(bResult.currentValue).toBe(1n);

    // Tenant A's continued accumulation also remains in their own bucket
    const aResult = await checkUnderTenant(tenantA, 'api_calls_per_minute', 1n);
    expect(aResult.currentValue).toBe(101n);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: audit emission for QUOTA_EXCEEDED
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — audit emission', () => {
  it('QUOTA_EXCEEDED event lands on rejection with stringified bigint after_state', async () => {
    const tenantId = await createTestTenant();
    await checkUnderTenant(tenantId, 'api_calls_per_minute', 600n); // at the limit
    const r = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
    expect(r.allowed).toBe(false);

    const rows = await fetchAuditRows(tenantId);
    const exceeded = rows.filter((r) => r.action === 'QUOTA_EXCEEDED');
    expect(exceeded).toHaveLength(1);

    const event = exceeded[0]!;
    expect(event.resource).toBe(`quota:${tenantId}:api_calls_per_minute`);
    const after = (event.payload as { after_state: Record<string, unknown> }).after_state;
    expect(after.resource_class).toBe('api_calls_per_minute');
    // BigInt → string conversion at the audit-payload boundary.
    expect(after.current_value).toBe('601');
    expect(after.quota_limit).toBe('600');
    expect(after.increment).toBe('1');
    expect(typeof after.window_start).toBe('string');
    expect(typeof after.window_end).toBe('string');
    expect(typeof after.retry_after_seconds).toBe('number');
  });

  it('every 429 emits its own audit event; chain integrity holds across rejections', async () => {
    const tenantId = await createTestTenant();
    await checkUnderTenant(tenantId, 'api_calls_per_minute', 600n);
    // 3 sequential rejections — library returns { allowed: false }
    for (let i = 0; i < 3; i++) {
      const r = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
      expect(r.allowed).toBe(false);
    }

    const rows = await fetchAuditRows(tenantId);
    expect(rows.map((r) => r.action)).toEqual([
      'QUOTA_EXCEEDED',
      'QUOTA_EXCEEDED',
      'QUOTA_EXCEEDED',
    ]);

    // Chain integrity: row[N].prev_hash equals row[N-1].curr_hash.
    expect(rows[1]!.prev_hash?.toString('hex')).toBe(rows[0]!.curr_hash.toString('hex'));
    expect(rows[2]!.prev_hash?.toString('hex')).toBe(rows[1]!.curr_hash.toString('hex'));
    // Each curr_hash is unique
    expect(rows[0]!.curr_hash.toString('hex')).not.toBe(rows[1]!.curr_hash.toString('hex'));
    expect(rows[1]!.curr_hash.toString('hex')).not.toBe(rows[2]!.curr_hash.toString('hex'));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: window rollover
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — window rollover', () => {
  it('a row in a past window does not collide with a current-window upsert', async () => {
    const tenantId = await createTestTenant();
    // Pre-insert a row with a 1-hour-ago window_start (well clear of any
    // wall-clock fuzz around the minute boundary)
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      await tx.execute(sql`
        INSERT INTO tenant_quota_usage
          (tenant_id, resource_class, current_value, quota_limit, window_start)
        VALUES (
          ${tenantId},
          'api_calls_per_minute',
          250::bigint,
          600::bigint,
          date_trunc('minute', clock_timestamp() AT TIME ZONE 'UTC' - interval '1 hour') AT TIME ZONE 'UTC'
        )
      `);
    });

    // Current-window check should INSERT a new row, not touch the past one
    const result = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
    expect(result.currentValue).toBe(1n); // current window starts fresh
    expect(result.allowed).toBe(true);

    const rows = await fetchQuotaRows(tenantId);
    expect(rows).toHaveLength(2);
    // Past row's current_value untouched (still 250)
    const past = rows[0]!;
    const current = rows[1]!;
    expect(BigInt(past.current_value)).toBe(250n);
    expect(BigInt(current.current_value)).toBe(1n);
    // Distinct window_start values. pg's type parser may return Date
    // or string depending on path; coerce both safely (same pattern
    // as check-quota.ts).
    const tsOf = (w: unknown): number =>
      w instanceof Date ? w.getTime() : new Date(String(w)).getTime();
    expect(tsOf(past.window_start)).toBeLessThan(tsOf(current.window_start));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: RLS denial
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — RLS denial', () => {
  it('checkQuota without bindTenantToDbSession throws QuotaExecutionError (42501)', async () => {
    const tenantId = await createTestTenant();
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        // No bindTenantToDbSession — tenant_quota_usage RLS denies the
        // upsert FIRST (before audit emission can fire). This differs
        // from @cortex/encryption's RLS denial path (envelope.encrypt
        // succeeds, audit fails) — here the upsert IS the first
        // RLS-protected write.
        await checkQuota(
          tx,
          { tenantId, resourceClass: 'api_calls_per_minute', increment: 1n },
          { tier: 'STANDARD' },
        );
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(QuotaExecutionError);
    const cause = (captured as { cause?: { code?: unknown } }).cause;
    expect(cause?.code).toBe('42501');

    // No audit row should have been emitted — upsert failed before reaching the audit branch.
    const rows = await fetchAuditRows(tenantId);
    expect(rows.filter((r) => r.action === 'QUOTA_EXCEEDED')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: validation failures
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — validation failures', () => {
  it('non-UUID tenantId throws QuotaValidationError before any DB call', async () => {
    const realTenantId = await createTestTenant();
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, realTenantId);
        await checkQuota(
          tx,
          { tenantId: 'not-a-uuid', resourceClass: 'api_calls_per_minute', increment: 1n },
          { tier: 'STANDARD' },
        );
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(QuotaValidationError);

    // No quota row inserted, no audit row emitted (validation throws
    // before any side effect).
    const quotaRows = await fetchQuotaRows(realTenantId);
    expect(quotaRows).toHaveLength(0);
    const auditRows = await fetchAuditRows(realTenantId);
    expect(auditRows.filter((r) => r.action === 'QUOTA_EXCEEDED')).toHaveLength(0);
  });

  it('negative bigint increment throws QuotaValidationError before any DB call', async () => {
    const tenantId = await createTestTenant();
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, tenantId);
        await checkQuota(
          tx,
          { tenantId, resourceClass: 'api_calls_per_minute', increment: -1n },
          { tier: 'STANDARD' },
        );
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(QuotaValidationError);

    const quotaRows = await fetchQuotaRows(tenantId);
    expect(quotaRows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: hybrid DI escape hatches
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — hybrid DI escape hatches', () => {
  it('__setCheckerForTesting + __resetForTesting swap and restore the module-scope checker', async () => {
    const tenantId = await createTestTenant();
    const sentinel: CheckQuota = {
      check: vi.fn(() =>
        Promise.resolve({
          allowed: true as const,
          currentValue: 999n,
          quotaLimit: 1000n,
          retryAfterSeconds: null,
          windowStart: '2026-04-26T00:00:00.000Z',
        }),
      ),
    };
    __setCheckerForTesting(sentinel);
    try {
      const swapped = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, tenantId);
        return checkQuota(
          tx,
          { tenantId, resourceClass: 'api_calls_per_minute', increment: 1n },
          { tier: 'STANDARD' },
        );
      });
      expect(swapped.currentValue).toBe(999n);
    } finally {
      __resetForTesting();
    }

    // After reset, default checker is back: real DB path returns currentValue=1n
    const defaultResult = await checkUnderTenant(tenantId, 'api_calls_per_minute', 1n);
    expect(defaultResult.currentValue).toBe(1n);
  });

  it('createQuotaChecker custom factory works independently of the module-scope default', async () => {
    const customChecker = createQuotaChecker();
    const tenantId = await createTestTenant();
    const result = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return customChecker.check(
        tx,
        { tenantId, resourceClass: 'api_calls_per_minute', increment: 1n },
        { tier: 'STANDARD' },
      );
    });
    expect(result.allowed).toBe(true);
    expect(result.currentValue).toBe(1n);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: concurrent atomic upsert (mini acceptance test)
// ─────────────────────────────────────────────────────────────────────

describe('checkQuota — concurrent atomic upsert', () => {
  it('10 parallel checkQuota calls produce exactly 10n final count (no lost updates)', async () => {
    const tenantId = await createTestTenant();
    const promises = Array.from({ length: 10 }, () =>
      checkUnderTenant(tenantId, 'api_calls_per_minute', 1n, 100n),
    );
    const results = await Promise.allSettled(promises);

    // All 10 should succeed (limit is 100, increment is 1, so all
    // under the limit even with no atomicity guarantees on resolution
    // ordering)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(10);

    // Final count via DB read: exactly 10n. If any update were lost, this
    // would be < 10n.
    const rows = await fetchQuotaRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0]!.current_value)).toBe(10n);
  });
});

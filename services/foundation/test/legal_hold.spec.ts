// Migration 0011 substrate tests for the legal_hold table. Verifies column
// shape, the three CHECK constraints (scope-record, scope-data_class,
// release-pair), RLS posture + isolation, and partial-index existence.
// Pairs with packages/tenant-context's workflow tests (sub-phase 7.5);
// this file owns the migration-level invariants.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '@cortex/canonical-schema/rls-test';
import { getPool as getTestPool } from '@cortex/test-db-harness';

const RUN_TAG = randomUUID().slice(0, 8);
const TENANT_A_ID = randomUUID();
const TENANT_B_ID = randomUUID();
const EXT_A = `lh-test-${RUN_TAG}-a`;
const EXT_B = `lh-test-${RUN_TAG}-b`;

async function withBoundClient(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe('legal_hold table (migration 0011)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await pool.query(
      `INSERT INTO tenant (id, external_id, display_name, tier)
         VALUES ($1, $2, 'Tenant A', 'STANDARD'), ($3, $4, 'Tenant B', 'STANDARD')`,
      [TENANT_A_ID, EXT_A, TENANT_B_ID, EXT_B],
    );
  });

  afterAll(async () => {
    for (const id of [TENANT_A_ID, TENANT_B_ID]) {
      try {
        await withBoundClient(pool, id, async (client) => {
          await client.query(`DELETE FROM legal_hold WHERE tenant_id = $1`, [id]);
        });
      } catch {
        // no rows; ignore.
      }
    }
    await pool.query(`DELETE FROM tenant WHERE id IN ($1, $2)`, [TENANT_A_ID, TENANT_B_ID]);
    await pool.end();
  });

  it('table exists with the expected column shape', async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'legal_hold'
         ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'id',
      'tenant_id',
      'scope',
      'record_id',
      'data_class',
      'reason',
      'set_by_user_id',
      'set_at',
      'released_at',
      'released_by_user_id',
    ]);
    const cols = new Map(rows.map((r) => [r.column_name, r] as const));
    expect(cols.get('id')?.data_type).toBe('uuid');
    expect(cols.get('tenant_id')?.data_type).toBe('uuid');
    expect(cols.get('tenant_id')?.is_nullable).toBe('NO');
    expect(cols.get('scope')?.data_type).toBe('text');
    expect(cols.get('scope')?.is_nullable).toBe('NO');
    expect(cols.get('set_by_user_id')?.data_type).toBe('text');
    expect(cols.get('set_by_user_id')?.is_nullable).toBe('NO');
    // set_at is timestamptz with the ms-truncated default per ADR-DB-002.
    expect(cols.get('set_at')?.data_type).toBe('timestamp with time zone');
    expect(cols.get('set_at')?.is_nullable).toBe('NO');
    expect(cols.get('released_at')?.is_nullable).toBe('YES');
    expect(cols.get('released_by_user_id')?.is_nullable).toBe('YES');
  });

  it('RLS is enabled (no FORCE — production runtime SAs are non-super)', async () => {
    const { rows } = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = 'legal_hold'`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(false);
  });

  it('scope=record without record_id rejects (CHECK 23514)', async () => {
    let captured: { code?: string; constraint?: string } | undefined;
    try {
      await withBoundClient(pool, TENANT_A_ID, async (client) => {
        await client.query(
          `INSERT INTO legal_hold (tenant_id, scope, record_id, reason, set_by_user_id)
             VALUES ($1, 'record', NULL, 'discovery hold', 'workos_user_abc')`,
          [TENANT_A_ID],
        );
      });
    } catch (err) {
      captured = err as { code?: string; constraint?: string };
    }
    expect(captured?.code).toBe('23514');
    expect(captured?.constraint).toBe('legal_hold_scope_record_check');
  });

  it('scope=data_class without data_class rejects (CHECK 23514)', async () => {
    let captured: { code?: string; constraint?: string } | undefined;
    try {
      await withBoundClient(pool, TENANT_A_ID, async (client) => {
        await client.query(
          `INSERT INTO legal_hold (tenant_id, scope, data_class, reason, set_by_user_id)
             VALUES ($1, 'data_class', NULL, 'retention hold', 'workos_user_abc')`,
          [TENANT_A_ID],
        );
      });
    } catch (err) {
      captured = err as { code?: string; constraint?: string };
    }
    expect(captured?.code).toBe('23514');
    expect(captured?.constraint).toBe('legal_hold_scope_data_class_check');
  });

  it('release-pair invariant: setting only released_at without released_by_user_id rejects', async () => {
    // First, insert a valid active hold.
    const holdId = randomUUID();
    await withBoundClient(pool, TENANT_A_ID, async (client) => {
      await client.query(
        `INSERT INTO legal_hold (id, tenant_id, scope, reason, set_by_user_id)
           VALUES ($1, $2, 'tenant', 'release-pair test', 'workos_user_abc')`,
        [holdId, TENANT_A_ID],
      );
    });

    // Try to release with only released_at set.
    let captured: { code?: string; constraint?: string } | undefined;
    try {
      await withBoundClient(pool, TENANT_A_ID, async (client) => {
        await client.query(`UPDATE legal_hold SET released_at = now() WHERE id = $1`, [holdId]);
      });
    } catch (err) {
      captured = err as { code?: string; constraint?: string };
    }
    expect(captured?.code).toBe('23514');
    expect(captured?.constraint).toBe('legal_hold_release_pair_check');

    // Cleanup: setting both fields together must succeed.
    await withBoundClient(pool, TENANT_A_ID, async (client) => {
      await client.query(
        `UPDATE legal_hold SET released_at = now(), released_by_user_id = 'workos_user_xyz'
           WHERE id = $1`,
        [holdId],
      );
    });
  });

  it('FK to tenant rejects orphan tenant_id (23503)', async () => {
    const orphanId = randomUUID();
    let captured: { code?: string } | undefined;
    try {
      await withBoundClient(pool, orphanId, async (client) => {
        await client.query(
          `INSERT INTO legal_hold (tenant_id, scope, reason, set_by_user_id)
             VALUES ($1, 'tenant', 'orphan FK test', 'workos_user_abc')`,
          [orphanId],
        );
      });
    } catch (err) {
      captured = err as { code?: string };
    }
    expect(captured?.code).toBe('23503');
  });

  it('RLS isolation: tenant B cannot see tenant A holds', async () => {
    await withBoundClient(pool, TENANT_A_ID, async (client) => {
      await client.query(
        `INSERT INTO legal_hold (tenant_id, scope, reason, set_by_user_id)
           VALUES ($1, 'tenant', 'isolation test A', 'workos_user_abc')`,
        [TENANT_A_ID],
      );
    });
    await withBoundClient(pool, TENANT_B_ID, async (client) => {
      await client.query(
        `INSERT INTO legal_hold (tenant_id, scope, reason, set_by_user_id)
           VALUES ($1, 'tenant', 'isolation test B', 'workos_user_abc')`,
        [TENANT_B_ID],
      );
    });

    const aSeen = await withTenantContext(pool, TENANT_A_ID, async (tx) => {
      const { rows } = await tx.query(`SELECT tenant_id FROM legal_hold`);
      return rows.map((r: { tenant_id: string }) => r.tenant_id);
    });
    expect(aSeen.every((id) => id === TENANT_A_ID)).toBe(true);
    expect(aSeen).not.toContain(TENANT_B_ID);

    const bSeen = await withTenantContext(pool, TENANT_B_ID, async (tx) => {
      const { rows } = await tx.query(`SELECT tenant_id FROM legal_hold`);
      return rows.map((r: { tenant_id: string }) => r.tenant_id);
    });
    expect(bSeen.every((id) => id === TENANT_B_ID)).toBe(true);
    expect(bSeen).not.toContain(TENANT_A_ID);
  });

  it('partial index legal_hold_tenant_active_idx exists with WHERE released_at IS NULL', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'legal_hold'
           AND indexname = 'legal_hold_tenant_active_idx'`,
    );
    expect(rows[0]?.indexdef).toMatch(/\(tenant_id, released_at\)/);
    expect(rows[0]?.indexdef).toMatch(/WHERE \(released_at IS NULL\)/);
  });

  it('partial index legal_hold_released_at_idx exists with WHERE released_at IS NOT NULL', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'legal_hold'
           AND indexname = 'legal_hold_released_at_idx'`,
    );
    expect(rows[0]?.indexdef).toMatch(/\(released_at\)/);
    expect(rows[0]?.indexdef).toMatch(/WHERE \(released_at IS NOT NULL\)/);
  });

  it('set_at default truncates to millisecond precision (ADR-DB-002)', async () => {
    const holdId = randomUUID();
    const micros = await withTenantContext(pool, TENANT_A_ID, async (tx) => {
      await tx.query(
        `INSERT INTO legal_hold (id, tenant_id, scope, reason, set_by_user_id)
           VALUES ($1, $2, 'tenant', 'ms-precision test', 'workos_user_abc')`,
        [holdId, TENANT_A_ID],
      );
      const { rows } = await tx.query<{ micros: string }>(
        `SELECT ((extract(epoch FROM set_at) * 1000000)::bigint % 1000)::text AS micros
           FROM legal_hold WHERE id = $1`,
        [holdId],
      );
      return Number(rows[0]?.micros);
    });
    expect(micros).toBe(0);
  });
});

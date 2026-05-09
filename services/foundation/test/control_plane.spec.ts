// Migration 0007 smoke + integration tests for the four control-plane
// tables: tenant, tenant_config_version, tenant_quota_usage,
// tenant_kms_key. Verifies shapes, constraints, FK + RLS posture, and
// the bigint quota column. Pairs with packages/tenant-context unit
// tests; this file owns the migration-level invariants.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '@cortex/canonical-schema/rls-test';
import { getPool as getTestPool } from '@cortex/test-db-harness';

const RUN_TAG = randomUUID().slice(0, 8);
const TENANT_A_ID = randomUUID();
const TENANT_B_ID = randomUUID();
const EXT_A = `cp-test-${RUN_TAG}-a`;
const EXT_B = `cp-test-${RUN_TAG}-b`;

/**
 * Run a callback inside a transaction with `app.tenant_id` bound. Used
 * for cleanup against RLS-protected tables.
 */
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

describe('control-plane tables (migration 0007)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();

    // Insert two test tenants used across FK + RLS-isolation tests.
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
          await client.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [id]);
          await client.query(`DELETE FROM tenant_quota_usage WHERE tenant_id = $1`, [id]);
        });
      } catch {
        // tenant may not have child rows; ignore.
      }
    }
    await pool.query(`DELETE FROM tenant WHERE id IN ($1, $2)`, [TENANT_A_ID, TENANT_B_ID]);
    await pool.end();
  });

  it('all 4 control-plane tables exist in the public schema', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('tenant', 'tenant_config_version',
                              'tenant_quota_usage', 'tenant_kms_key')
         ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'tenant',
      'tenant_config_version',
      'tenant_kms_key',
      'tenant_quota_usage',
    ]);
  });

  it('column shapes match the migration 0007 spec', async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('tenant', 'tenant_config_version',
                              'tenant_quota_usage', 'tenant_kms_key')`,
    );
    const cols = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r] as const));

    const tenantExtId = cols.get('tenant.external_id');
    expect(tenantExtId?.data_type).toBe('text');
    expect(tenantExtId?.is_nullable).toBe('NO');

    const tenantTier = cols.get('tenant.tier');
    expect(tenantTier?.data_type).toBe('text');
    expect(tenantTier?.is_nullable).toBe('NO');

    const tenantStatus = cols.get('tenant.status');
    expect(tenantStatus?.data_type).toBe('text');
    expect(tenantStatus?.is_nullable).toBe('NO');
    expect(tenantStatus?.column_default).toContain("'PROVISIONING'");

    const cvTenantId = cols.get('tenant_config_version.tenant_id');
    expect(cvTenantId?.data_type).toBe('uuid');
    expect(cvTenantId?.is_nullable).toBe('NO');

    const quotaCurrent = cols.get('tenant_quota_usage.current_value');
    expect(quotaCurrent?.data_type).toBe('bigint');
    expect(quotaCurrent?.is_nullable).toBe('NO');

    const kmsTenantId = cols.get('tenant_kms_key.tenant_id');
    expect(kmsTenantId?.data_type).toBe('uuid');
    expect(kmsTenantId?.is_nullable).toBe('NO');
  });

  it('RLS posture: tenant has no RLS; the 3 child tables have RLS enabled', async () => {
    const { rows } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity
         FROM pg_class
         WHERE relname IN ('tenant', 'tenant_config_version',
                           'tenant_quota_usage', 'tenant_kms_key')
         ORDER BY relname`,
    );
    const map = new Map(rows.map((r) => [r.relname, r.relrowsecurity] as const));
    expect(map.get('tenant')).toBe(false);
    expect(map.get('tenant_config_version')).toBe(true);
    expect(map.get('tenant_quota_usage')).toBe(true);
    expect(map.get('tenant_kms_key')).toBe(true);
  });

  it('FK ON DELETE RESTRICT prevents tenant deletion when a config row references it', async () => {
    // Insert a config_version for TENANT_A.
    await withBoundClient(pool, TENANT_A_ID, async (client) => {
      await client.query(
        `INSERT INTO tenant_config_version (tenant_id, version_number, config_json)
           VALUES ($1, 1, '{}'::jsonb)
           ON CONFLICT DO NOTHING`,
        [TENANT_A_ID],
      );
    });

    let captured: { code?: string } | undefined;
    try {
      await pool.query('DELETE FROM tenant WHERE id = $1', [TENANT_A_ID]);
    } catch (err) {
      captured = err as { code?: string };
    }
    expect(captured?.code).toBe('23503'); // foreign_key_violation

    // Restore — afterAll's bound DELETE will pick up the config row.
  });

  it('UNIQUE on tenant.external_id rejects duplicate inserts (23505)', async () => {
    let captured: { code?: string } | undefined;
    try {
      await pool.query(
        `INSERT INTO tenant (external_id, display_name, tier)
           VALUES ($1, 'Dup A', 'STANDARD')`,
        [EXT_A],
      );
    } catch (err) {
      captured = err as { code?: string };
    }
    expect(captured?.code).toBe('23505');
  });

  it('UNIQUE composites on tenant_config_version + tenant_quota_usage reject duplicates', async () => {
    // (tenant_id, version_number) — TENANT_A already has v=1 from FK test.
    let configCaptured: { code?: string } | undefined;
    try {
      await withBoundClient(pool, TENANT_A_ID, async (client) => {
        await client.query(
          `INSERT INTO tenant_config_version (tenant_id, version_number, config_json)
             VALUES ($1, 1, '{}'::jsonb)`,
          [TENANT_A_ID],
        );
      });
    } catch (err) {
      configCaptured = err as { code?: string };
    }
    expect(configCaptured?.code).toBe('23505');

    // (tenant_id, resource_class, window_start) — insert once, then dup.
    const windowStart = new Date('2026-01-01T00:00:00Z').toISOString();
    await withBoundClient(pool, TENANT_A_ID, async (client) => {
      await client.query(
        `INSERT INTO tenant_quota_usage
           (tenant_id, resource_class, current_value, quota_limit, window_start)
         VALUES ($1, 'api_requests', 0, 100, $2)`,
        [TENANT_A_ID, windowStart],
      );
    });
    let quotaCaptured: { code?: string } | undefined;
    try {
      await withBoundClient(pool, TENANT_A_ID, async (client) => {
        await client.query(
          `INSERT INTO tenant_quota_usage
             (tenant_id, resource_class, current_value, quota_limit, window_start)
           VALUES ($1, 'api_requests', 0, 100, $2)`,
          [TENANT_A_ID, windowStart],
        );
      });
    } catch (err) {
      quotaCaptured = err as { code?: string };
    }
    expect(quotaCaptured?.code).toBe('23505');
  });

  it('UNIQUE on tenant_kms_key.tenant_id is declared in the schema', async () => {
    // Verify the UNIQUE constraint exists via the catalog. (Migration
    // 0009 widened the policy from SELECT-only to FOR ALL, but the
    // catalog-level check remains the authoritative shape assertion.)
    const { rows } = await pool.query<{
      conname: string;
      contype: string;
      attnames: string[];
    }>(
      `SELECT c.conname, c.contype::text AS contype,
              array_agg(a.attname::text ORDER BY u.ord)::text[] AS attnames
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
         WHERE c.conrelid = 'tenant_kms_key'::regclass
           AND c.contype = 'u'
         GROUP BY c.conname, c.contype`,
    );
    const tenantIdUnique = rows.find(
      (r) => r.attnames.length === 1 && r.attnames[0] === 'tenant_id',
    );
    expect(tenantIdUnique).toBeDefined();
  });

  it('tenant_kms_key permits INSERT/SELECT under tenant binding (migration 0009)', async () => {
    const tenantId = randomUUID();
    await pool.query(
      `INSERT INTO tenant (id, external_id, display_name, tier)
         VALUES ($1, $2, 'KMS Bind Test', 'STANDARD')`,
      [tenantId, `cp-test-${RUN_TAG}-kms-${tenantId.slice(0, 8)}`],
    );
    try {
      await withBoundClient(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenant_kms_key (tenant_id, kms_key_resource_name) VALUES ($1, $2)`,
          [tenantId, 'projects/test/locations/asia-south1/keyRings/r/cryptoKeys/k'],
        );
        const r = await client.query<{ kms_key_resource_name: string }>(
          `SELECT kms_key_resource_name FROM tenant_kms_key WHERE tenant_id = $1`,
          [tenantId],
        );
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0]?.kms_key_resource_name).toContain('cryptoKeys/k');
      });
    } finally {
      await withBoundClient(pool, tenantId, async (client) => {
        await client.query(`DELETE FROM tenant_kms_key WHERE tenant_id = $1`, [tenantId]);
      });
      await pool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    }
  });

  it('CHECK constraints reject invalid tier and status values (23514)', async () => {
    let tierCaptured: { code?: string } | undefined;
    try {
      await pool.query(
        `INSERT INTO tenant (external_id, display_name, tier)
           VALUES ($1, 'Bad Tier', 'PREMIUM')`,
        [`cp-test-${RUN_TAG}-bad-tier`],
      );
    } catch (err) {
      tierCaptured = err as { code?: string };
    }
    expect(tierCaptured?.code).toBe('23514');

    let statusCaptured: { code?: string } | undefined;
    try {
      await pool.query(
        `INSERT INTO tenant (external_id, display_name, tier, status)
           VALUES ($1, 'Bad Status', 'STANDARD', 'ARCHIVED')`,
        [`cp-test-${RUN_TAG}-bad-status`],
      );
    } catch (err) {
      statusCaptured = err as { code?: string };
    }
    expect(statusCaptured?.code).toBe('23514');
  });

  it('RLS isolation: tenant B cannot see tenant A config rows', async () => {
    // TENANT_A already has a config row (v=1) from the FK test. Insert
    // a B-owned row to keep both sides non-empty.
    await withBoundClient(pool, TENANT_B_ID, async (client) => {
      await client.query(
        `INSERT INTO tenant_config_version (tenant_id, version_number, config_json)
           VALUES ($1, 1, '{}'::jsonb)
           ON CONFLICT DO NOTHING`,
        [TENANT_B_ID],
      );
    });

    const aSeen = await withTenantContext(pool, TENANT_A_ID, async (tx) => {
      const { rows } = await tx.query(`SELECT tenant_id FROM tenant_config_version`);
      return rows.map((r: { tenant_id: string }) => r.tenant_id);
    });
    expect(aSeen.every((id) => id === TENANT_A_ID)).toBe(true);
    expect(aSeen).not.toContain(TENANT_B_ID);

    const bSeen = await withTenantContext(pool, TENANT_B_ID, async (tx) => {
      const { rows } = await tx.query(`SELECT tenant_id FROM tenant_config_version`);
      return rows.map((r: { tenant_id: string }) => r.tenant_id);
    });
    expect(bSeen.every((id) => id === TENANT_B_ID)).toBe(true);
    expect(bSeen).not.toContain(TENANT_A_ID);
  });

  it('bigint columns preserve values above Number.MAX_SAFE_INTEGER', async () => {
    // 2^53 + 5 — outside the safe integer range. Postgres bigint covers
    // it; pg-node returns bigint columns as strings by default, so we
    // can compare without precision loss.
    const bigValue = (BigInt(Number.MAX_SAFE_INTEGER) + 5n).toString();
    const windowStart = new Date('2026-02-01T00:00:00Z').toISOString();

    await withBoundClient(pool, TENANT_A_ID, async (client) => {
      await client.query(
        `INSERT INTO tenant_quota_usage
           (tenant_id, resource_class, current_value, quota_limit, window_start)
         VALUES ($1, 'storage_bytes', $2::bigint, 999999999999, $3)`,
        [TENANT_A_ID, bigValue, windowStart],
      );
    });

    const seen = await withTenantContext(pool, TENANT_A_ID, async (tx) => {
      const { rows } = await tx.query(
        `SELECT current_value::text AS current_value
           FROM tenant_quota_usage
           WHERE tenant_id = $1 AND resource_class = 'storage_bytes'
             AND window_start = $2`,
        [TENANT_A_ID, windowStart],
      );
      return rows[0] as { current_value: string };
    });
    expect(seen.current_value).toBe(bigValue);
  });
});

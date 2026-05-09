// TODO: when multi-developer testing arrives, restructure to use a dedicated
// _test schema that's dropped CASCADE at suite end to avoid public-schema
// pollution. Phase B single-operator dev: the _test_ prefix is sufficient.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { withTenantContext, withoutTenantContext } from '@cortex/canonical-schema/rls-test';
import { getPool as getTestPool } from '@cortex/test-db-harness';

const TABLE = '_test_rls_tenants';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('RLS baseline (ADR-DB-002)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(`
      CREATE TABLE ${TABLE} (
        id        uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid    NOT NULL,
        name      text    NOT NULL
      )
    `);
    await pool.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
    // FORCE makes policies apply to the table owner (postgres) as well.
    // Tests run as postgres (superuser) which by default bypasses RLS;
    // without FORCE, cross-tenant isolation assertions would be invalidated.
    // Real Phase-1 tables don't strictly need FORCE because F01 middleware
    // never runs as superuser — but the test must use FORCE to validate policies.
    await pool.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
    await pool.query(`
      CREATE POLICY tenant_read_policy ON ${TABLE}
        FOR SELECT TO public
        USING (tenant_id = cortex.current_tenant_id())
    `);
    await pool.query(`
      CREATE POLICY tenant_write_policy ON ${TABLE}
        FOR ALL TO public
        USING (tenant_id = cortex.current_tenant_id())
        WITH CHECK (tenant_id = cortex.current_tenant_id())
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.end();
  });

  describe('cortex.current_tenant_id()', () => {
    it('returns the uuid when app.tenant_id is set via SET LOCAL', async () => {
      const result = await withTenantContext(pool, TENANT_A, async (tx) => {
        const { rows } = await tx.query('SELECT cortex.current_tenant_id() AS t');
        return rows[0].t as string;
      });
      expect(result).toBe(TENANT_A);
    });

    it('raises 42501 when app.tenant_id is unset', async () => {
      await expect(
        withoutTenantContext(pool, async (tx) => {
          await tx.query('SELECT cortex.current_tenant_id()');
        }),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('app.tenant_id is not set'),
      });
    });

    it('raises 42501 when app.tenant_id is an empty string', async () => {
      // Raw client path — withTenantContext uses a bound parameter which
      // can't express the empty-string case cleanly.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.tenant_id = ''");
        await expect(client.query('SELECT cortex.current_tenant_id()')).rejects.toMatchObject({
          code: '42501',
          message: expect.stringContaining('app.tenant_id is not set'),
        });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('raises 22P02 when app.tenant_id is not a valid uuid', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL app.tenant_id = 'not-a-uuid'");
        await expect(client.query('SELECT cortex.current_tenant_id()')).rejects.toMatchObject({
          code: '22P02',
        });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('tenant_read_policy + tenant_write_policy', () => {
    it('tenant A can INSERT and SELECT their own rows', async () => {
      await withTenantContext(pool, TENANT_A, async (tx) => {
        await tx.query(`INSERT INTO ${TABLE} (tenant_id, name) VALUES ($1, $2)`, [
          TENANT_A,
          'row-a-1',
        ]);
      });
      const rows = await withTenantContext(pool, TENANT_A, async (tx) => {
        const { rows } = await tx.query(`SELECT name FROM ${TABLE}`);
        return rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('row-a-1');
    });

    it("tenant B cannot SELECT tenant A's rows", async () => {
      const rows = await withTenantContext(pool, TENANT_B, async (tx) => {
        const { rows } = await tx.query(`SELECT name FROM ${TABLE}`);
        return rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('tenant A cannot INSERT a row with tenant_id = tenant B', async () => {
      await expect(
        withTenantContext(pool, TENANT_A, async (tx) => {
          await tx.query(`INSERT INTO ${TABLE} (tenant_id, name) VALUES ($1, $2)`, [
            TENANT_B,
            'cross-tenant-insert',
          ]);
        }),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('row-level security policy'),
      });
    });

    it('without tenant context, SELECT raises via current_tenant_id', async () => {
      await expect(
        withoutTenantContext(pool, async (tx) => {
          await tx.query(`SELECT * FROM ${TABLE}`);
        }),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('app.tenant_id is not set'),
      });
    });
  });
});

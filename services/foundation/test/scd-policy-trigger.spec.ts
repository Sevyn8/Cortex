/**
 * F03 Slice C C.4 — per-type SCD trigger behavior tests.
 *
 * Exercises `cortex.cortex_scd_trigger()` against tenant.scd policies
 * for all 5 SCD types (1, 2, 3, 4, 6) plus default-when-absent
 * fallback (Q-NEW-F03C-4) and F04 lifecycle integration (Q-NEW-F03C-5/6).
 *
 * Test fixtures (created in beforeAll, dropped in afterAll):
 *   _test_scd_main       — main tracked table with sibling _previous
 *                          columns + bi-temporal recipe; used for
 *                          Types 1, 2, 3, 6, default-fallback
 *   _test_scd_main_history — Type 4 history table (same shape as main)
 *   _test_scd_no_sibling — Type 3 missing-sibling test (no _previous col)
 *   _test_scd_no_history — Type 4 missing-history test (no sibling table)
 *
 * Tenant-context handling:
 *   - Fixture inserts (policies, test rows) run as `postgres` user
 *     which owns `tenant_config_version` and bypasses RLS without
 *     binding (NO FORCE per migration 0007).
 *   - UPDATE/DELETE on test tables run via `withTenantContext` so
 *     `cortex.current_tenant_id()` resolves and the trigger's policy
 *     lookup succeeds. Test tables themselves have no RLS — they're
 *     temporary fixtures.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { withTenantContext } from '@cortex/canonical-schema/rls-test';
import {
  createDraft,
  promoteDraft,
  registerNamespaceSchema,
  resetSchemaRegistry,
  validateDraft,
  type Actor,
} from '@cortex/config-plane';
import {
  SCDPolicySchema,
  SCD_POLICY_NAMESPACE,
  SCD_POLICY_SCHEMA_VERSION,
} from '@cortex/temporal-query';

const MAIN_TABLE = '_test_scd_main';
const MAIN_HISTORY = '_test_scd_main_history';
const NO_SIBLING_TABLE = '_test_scd_no_sibling';
const NO_HISTORY_TABLE = '_test_scd_no_history';

const userActor: Actor = { type: 'user', id: randomUUID(), description: 'F03 SCD trigger test' };

function makePostgresPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) throw new Error('PGPASSWORD not set');
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: 'postgres',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

function makeTestUserPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) throw new Error('PGPASSWORD not set');
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'test_user',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

// FK-safe cleanup of state created during tests in this suite. Mirrors
// `packages/config-plane/test/_utils/cleanup.ts`'s
// `cleanupConfigPlaneState` (inlined here to avoid a cross-package
// test-utility import).
async function cleanupTenantPlaneState(pool: Pool, tenantId: string): Promise<void> {
  await pool
    .query(`DELETE FROM audit_event WHERE tenant_id = $1`, [tenantId])
    .catch(() => undefined);
  await pool.query(`DELETE FROM config_draft WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [tenantId]);
}

async function makeTenant(pgPool: Pool, externalId: string): Promise<string> {
  const r = await pgPool.query<{ id: string }>(
    `INSERT INTO tenant (external_id, display_name, tier, status)
     VALUES ($1, $2, 'STANDARD', 'PROVISIONING')
     ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
     RETURNING id`,
    [externalId, `F03 SCD test tenant ${externalId}`],
  );
  return r.rows[0]!.id;
}

// Insert a tenant.scd policy for the given tenant via raw SQL
// (postgres user bypasses RLS on the FOR-ALL-policied table).
async function insertScdPolicy(
  pgPool: Pool,
  tenantId: string,
  policy: Record<string, unknown>,
): Promise<void> {
  await pgPool.query(
    `INSERT INTO tenant_config_version
       (tenant_id, namespace, version_number, schema_version, config_json)
     VALUES ($1, 'tenant.scd', 1, 1, $2::jsonb)`,
    [tenantId, JSON.stringify(policy)],
  );
}

describe('cortex_scd_trigger — SCD policy dispatch (F03 Slice C C.4)', () => {
  let pgPool: Pool;
  let testPool: Pool;

  beforeAll(async () => {
    pgPool = makePostgresPool();
    testPool = makeTestUserPool();

    // Fixture: main table with bi-temporal + payload + sibling _previous columns.
    // Used by Types 1, 2, 3, 6, default-fallback. Type 4 also uses this
    // table with the matching _history table below.
    await pgPool.query(`DROP TABLE IF EXISTS ${MAIN_HISTORY} CASCADE`);
    await pgPool.query(`DROP TABLE IF EXISTS ${MAIN_TABLE} CASCADE`);
    await pgPool.query(`
      CREATE TABLE ${MAIN_TABLE} (
        id              uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid       NOT NULL,
        name            text       NOT NULL,
        status          text,
        priority        integer,
        name_previous   text,
        status_previous text,
        priority_previous integer,
        valid_time      tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL),
        txn_time        tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL)
      )
    `);
    await pgPool.query(`
      CREATE TRIGGER ${MAIN_TABLE}_scd
        BEFORE INSERT OR UPDATE OR DELETE ON ${MAIN_TABLE}
        FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger()
    `);
    // GRANT to test_user so tenant-bound UPDATE/DELETE through the
    // testPool (which connects as test_user per the CI bootstrap)
    // can mutate these fixture tables. Default-grant from the CI
    // bootstrap covers tables existing at bootstrap time only;
    // fixtures created in beforeAll need explicit GRANTs.
    await pgPool.query(`GRANT ALL ON ${MAIN_TABLE} TO test_user`);

    // History fixture for Type 4 — same shape as MAIN_TABLE so
    // `INSERT INTO history SELECT ($1).*` from the trigger succeeds.
    await pgPool.query(`
      CREATE TABLE ${MAIN_HISTORY} (LIKE ${MAIN_TABLE} INCLUDING ALL)
    `);
    await pgPool.query(`GRANT ALL ON ${MAIN_HISTORY} TO test_user`);

    // No-sibling fixture for Type 3 RAISE test.
    await pgPool.query(`DROP TABLE IF EXISTS ${NO_SIBLING_TABLE} CASCADE`);
    await pgPool.query(`
      CREATE TABLE ${NO_SIBLING_TABLE} (
        id          uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid       NOT NULL,
        name        text       NOT NULL,
        valid_time  tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL),
        txn_time    tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL)
      )
    `);
    await pgPool.query(`
      CREATE TRIGGER ${NO_SIBLING_TABLE}_scd
        BEFORE INSERT OR UPDATE OR DELETE ON ${NO_SIBLING_TABLE}
        FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger()
    `);
    await pgPool.query(`GRANT ALL ON ${NO_SIBLING_TABLE} TO test_user`);

    // No-history fixture for Type 4 RAISE test.
    await pgPool.query(`DROP TABLE IF EXISTS ${NO_HISTORY_TABLE} CASCADE`);
    await pgPool.query(`
      CREATE TABLE ${NO_HISTORY_TABLE} (
        id          uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid       NOT NULL,
        name        text       NOT NULL,
        valid_time  tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL),
        txn_time    tstzrange  NOT NULL DEFAULT tstzrange(now(), NULL)
      )
    `);
    await pgPool.query(`
      CREATE TRIGGER ${NO_HISTORY_TABLE}_scd
        BEFORE INSERT OR UPDATE OR DELETE ON ${NO_HISTORY_TABLE}
        FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger()
    `);
    await pgPool.query(`GRANT ALL ON ${NO_HISTORY_TABLE} TO test_user`);
  });

  afterAll(async () => {
    await pgPool.query(`DROP TABLE IF EXISTS ${MAIN_HISTORY} CASCADE`);
    await pgPool.query(`DROP TABLE IF EXISTS ${MAIN_TABLE} CASCADE`);
    await pgPool.query(`DROP TABLE IF EXISTS ${NO_SIBLING_TABLE} CASCADE`);
    await pgPool.query(`DROP TABLE IF EXISTS ${NO_HISTORY_TABLE} CASCADE`);
    await pgPool.end();
    await testPool.end();
  });

  // ─────────────────────────────────────────────────────────────────
  // Type 1 — overwrite (no history)
  // ─────────────────────────────────────────────────────────────────

  describe('Type 1 — overwrite', () => {
    it('UPDATE modifies in place; row id stable; no history', async () => {
      const tenantId = await makeTenant(pgPool, `t1-update-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, { [MAIN_TABLE]: { type: 1 } });

        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name, status, priority)
           VALUES ($1, 'orig', 'open', 1) RETURNING id`,
          [tenantId],
        );
        const origId = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'updated', priority = 2 WHERE id = $1`, [
            origId,
          ]);
        });

        const after = await pgPool.query<{
          id: string;
          name: string;
          priority: number;
          name_previous: string | null;
        }>(`SELECT id, name, priority, name_previous FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [
          tenantId,
        ]);
        expect(after.rows).toHaveLength(1);
        expect(after.rows[0]!.id).toBe(origId);
        expect(after.rows[0]!.name).toBe('updated');
        expect(after.rows[0]!.priority).toBe(2);
        expect(after.rows[0]!.name_previous).toBeNull();
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('DELETE physically removes the row', async () => {
      const tenantId = await makeTenant(pgPool, `t1-delete-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, { [MAIN_TABLE]: { type: 1 } });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'a') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`DELETE FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        });

        const after = await pgPool.query(`SELECT id FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        expect(after.rows).toHaveLength(0);
      } finally {
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Type 2 — row rotation (canonical bi-temporal default)
  // ─────────────────────────────────────────────────────────────────

  describe('Type 2 — row rotation', () => {
    it('UPDATE closes OLD txn_time; INSERTs new row with rotated id', async () => {
      const tenantId = await makeTenant(pgPool, `t2-update-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, { [MAIN_TABLE]: { type: 2 } });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'orig') RETURNING id`,
          [tenantId],
        );
        const origId = inserted.rows[0]!.id;
        // Sleep to ensure INSERT and UPDATE land in different ms.
        // Without this, CI's fast execution can land both in the same
        // ms quantum → close-update produces tstzrange(X, X) (empty
        // range; upper IS NULL) and ORDER BY lower(txn_time) is
        // non-deterministic for tied keys.
        await new Promise((r) => setTimeout(r, 5));

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'rotated' WHERE id = $1`, [origId]);
        });

        const all = await pgPool.query<{
          id: string;
          name: string;
          txn_upper: string | null;
        }>(
          // ORDER BY upper(txn_time) NULLS LAST — closed (OLD) first,
          // open (NEW) last. Deterministic regardless of timestamp
          // tie-break.
          `SELECT id, name, upper(txn_time)::text AS txn_upper FROM ${MAIN_TABLE}
           WHERE tenant_id = $1 ORDER BY upper(txn_time) NULLS LAST`,
          [tenantId],
        );
        expect(all.rows).toHaveLength(2);
        expect(all.rows[0]!.id).toBe(origId);
        expect(all.rows[0]!.name).toBe('orig');
        expect(all.rows[0]!.txn_upper).not.toBeNull();
        expect(all.rows[1]!.id).not.toBe(origId);
        expect(all.rows[1]!.name).toBe('rotated');
        expect(all.rows[1]!.txn_upper).toBeNull();
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('DELETE logically closes (row stays; txn_time upper set)', async () => {
      const tenantId = await makeTenant(pgPool, `t2-delete-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, { [MAIN_TABLE]: { type: 2 } });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'a') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;
        await new Promise((r) => setTimeout(r, 5));

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`DELETE FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        });

        const after = await pgPool.query<{ txn_upper: string | null }>(
          `SELECT upper(txn_time)::text AS txn_upper FROM ${MAIN_TABLE} WHERE id = $1`,
          [id],
        );
        expect(after.rows).toHaveLength(1);
        expect(after.rows[0]!.txn_upper).not.toBeNull();
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Type 3 — single previous-value column
  // ─────────────────────────────────────────────────────────────────

  describe('Type 3 — previous value in column', () => {
    it('UPDATE captures OLD value into <col>_previous sibling; row in place', async () => {
      const tenantId = await makeTenant(pgPool, `t3-update-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: { type: 3, previousValueColumn: 'name' },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'orig-name') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'new-name' WHERE id = $1`, [id]);
        });

        const after = await pgPool.query<{ name: string; name_previous: string }>(
          `SELECT name, name_previous FROM ${MAIN_TABLE} WHERE id = $1`,
          [id],
        );
        expect(after.rows[0]!.name).toBe('new-name');
        expect(after.rows[0]!.name_previous).toBe('orig-name');
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('UPDATE with sibling column missing raises clean error', async () => {
      const tenantId = await makeTenant(pgPool, `t3-no-sib-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [NO_SIBLING_TABLE]: { type: 3, previousValueColumn: 'name' },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${NO_SIBLING_TABLE} (tenant_id, name) VALUES ($1, 'orig') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await expect(
          withTenantContext(testPool, tenantId, async (tx) => {
            await tx.query(`UPDATE ${NO_SIBLING_TABLE} SET name = 'new' WHERE id = $1`, [id]);
          }),
        ).rejects.toThrow(/sibling column .+ missing/i);
      } finally {
        await pgPool.query(`DELETE FROM ${NO_SIBLING_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('DELETE physically removes the row (Type 3 not history-preserving on delete)', async () => {
      const tenantId = await makeTenant(pgPool, `t3-delete-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: { type: 3, previousValueColumn: 'name' },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'a') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`DELETE FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        });

        const after = await pgPool.query(`SELECT id FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        expect(after.rows).toHaveLength(0);
      } finally {
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Type 4 — separate history table
  // ─────────────────────────────────────────────────────────────────

  describe('Type 4 — history table', () => {
    it('UPDATE: caller UPDATE in-place; OLD INSERTed into history table', async () => {
      const tenantId = await makeTenant(pgPool, `t4-update-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: { type: 4, historyTableName: MAIN_HISTORY },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'orig') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'new' WHERE id = $1`, [id]);
        });

        const main = await pgPool.query<{ name: string }>(
          `SELECT name FROM ${MAIN_TABLE} WHERE id = $1`,
          [id],
        );
        expect(main.rows[0]!.name).toBe('new');

        const history = await pgPool.query<{ id: string; name: string }>(
          `SELECT id, name FROM ${MAIN_HISTORY} WHERE tenant_id = $1`,
          [tenantId],
        );
        expect(history.rows).toHaveLength(1);
        expect(history.rows[0]!.id).toBe(id);
        expect(history.rows[0]!.name).toBe('orig');
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_HISTORY} WHERE tenant_id = $1`, [tenantId]);
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('DELETE: physical delete from main; OLD copied to history', async () => {
      const tenantId = await makeTenant(pgPool, `t4-delete-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: { type: 4, historyTableName: MAIN_HISTORY },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'doomed') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`DELETE FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        });

        const main = await pgPool.query(`SELECT id FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        expect(main.rows).toHaveLength(0);

        const history = await pgPool.query<{ name: string }>(
          `SELECT name FROM ${MAIN_HISTORY} WHERE id = $1`,
          [id],
        );
        expect(history.rows).toHaveLength(1);
        expect(history.rows[0]!.name).toBe('doomed');
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_HISTORY} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('UPDATE with history table missing raises clean error', async () => {
      const tenantId = await makeTenant(pgPool, `t4-no-hist-${randomUUID()}`);
      try {
        // Default historyTableName fallback will resolve to
        // `${NO_HISTORY_TABLE}_history` which does not exist.
        await insertScdPolicy(pgPool, tenantId, {
          [NO_HISTORY_TABLE]: { type: 4 },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${NO_HISTORY_TABLE} (tenant_id, name) VALUES ($1, 'a') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await expect(
          withTenantContext(testPool, tenantId, async (tx) => {
            await tx.query(`UPDATE ${NO_HISTORY_TABLE} SET name = 'b' WHERE id = $1`, [id]);
          }),
        ).rejects.toThrow(/history table .+ missing/i);
      } finally {
        await pgPool.query(`DELETE FROM ${NO_HISTORY_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('historyTableName defaults to <table>_history when omitted', async () => {
      // Validates the default-name fallback by creating a matching
      // sibling history table for MAIN_TABLE under the default name
      // — i.e., `<MAIN_TABLE>_history` already exists as MAIN_HISTORY,
      // so policy with no historyTableName resolves correctly.
      const tenantId = await makeTenant(pgPool, `t4-default-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: { type: 4 }, // omit historyTableName
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'pre') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'post' WHERE id = $1`, [id]);
        });

        const history = await pgPool.query<{ name: string }>(
          `SELECT name FROM ${MAIN_HISTORY} WHERE id = $1`,
          [id],
        );
        expect(history.rows).toHaveLength(1);
        expect(history.rows[0]!.name).toBe('pre');
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_HISTORY} WHERE tenant_id = $1`, [tenantId]);
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Type 6 — hybrid (Type 2 + per-column previous)
  // ─────────────────────────────────────────────────────────────────

  describe('Type 6 — hybrid', () => {
    it('UPDATE: row rotation + multi-column _previous capture', async () => {
      const tenantId = await makeTenant(pgPool, `t6-update-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: {
            type: 6,
            previousValueColumns: ['name', 'status'],
          },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name, status, priority)
           VALUES ($1, 'orig-name', 'orig-status', 1)
           RETURNING id`,
          [tenantId],
        );
        const origId = inserted.rows[0]!.id;
        // Sleep to ensure INSERT and UPDATE land in different ms.
        await new Promise((r) => setTimeout(r, 5));

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(
            `UPDATE ${MAIN_TABLE} SET name = 'new-name', status = 'new-status', priority = 2 WHERE id = $1`,
            [origId],
          );
        });

        const all = await pgPool.query<{
          id: string;
          name: string;
          status: string;
          priority: number;
          name_previous: string | null;
          status_previous: string | null;
          priority_previous: number | null;
          txn_upper: string | null;
        }>(
          // ORDER BY upper(txn_time) NULLS LAST — closed (OLD) first,
          // open (NEW) last. Deterministic regardless of timestamp tie.
          `SELECT id, name, status, priority, name_previous, status_previous,
                  priority_previous, upper(txn_time)::text AS txn_upper
           FROM ${MAIN_TABLE}
           WHERE tenant_id = $1
           ORDER BY upper(txn_time) NULLS LAST`,
          [tenantId],
        );
        expect(all.rows).toHaveLength(2);
        // Rotated NEW row carries new values + captured previous values.
        const newRow = all.rows[1]!;
        expect(newRow.id).not.toBe(origId);
        expect(newRow.name).toBe('new-name');
        expect(newRow.status).toBe('new-status');
        expect(newRow.priority).toBe(2);
        expect(newRow.name_previous).toBe('orig-name');
        expect(newRow.status_previous).toBe('orig-status');
        // priority NOT in previousValueColumns → not captured.
        expect(newRow.priority_previous).toBeNull();
        expect(newRow.txn_upper).toBeNull();
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('UPDATE with empty previousValueColumns behaves as pure Type 2', async () => {
      const tenantId = await makeTenant(pgPool, `t6-empty-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: { type: 6, previousValueColumns: [] },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'a') RETURNING id`,
          [tenantId],
        );
        const origId = inserted.rows[0]!.id;
        await new Promise((r) => setTimeout(r, 5));

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'b' WHERE id = $1`, [origId]);
        });

        const all = await pgPool.query<{ name: string; name_previous: string | null }>(
          `SELECT name, name_previous FROM ${MAIN_TABLE} WHERE tenant_id = $1
           ORDER BY upper(txn_time) NULLS LAST`,
          [tenantId],
        );
        expect(all.rows).toHaveLength(2);
        expect(all.rows[1]!.name).toBe('b');
        expect(all.rows[1]!.name_previous).toBeNull();
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });

    it('DELETE: Type 2 logical close (no per-column capture on delete)', async () => {
      const tenantId = await makeTenant(pgPool, `t6-delete-${randomUUID()}`);
      try {
        await insertScdPolicy(pgPool, tenantId, {
          [MAIN_TABLE]: { type: 6, previousValueColumns: ['name'] },
        });
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'a') RETURNING id`,
          [tenantId],
        );
        const id = inserted.rows[0]!.id;
        await new Promise((r) => setTimeout(r, 5));

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`DELETE FROM ${MAIN_TABLE} WHERE id = $1`, [id]);
        });

        const after = await pgPool.query<{
          txn_upper: string | null;
          name_previous: string | null;
        }>(
          `SELECT upper(txn_time)::text AS txn_upper, name_previous
           FROM ${MAIN_TABLE} WHERE id = $1`,
          [id],
        );
        expect(after.rows).toHaveLength(1);
        expect(after.rows[0]!.txn_upper).not.toBeNull();
        expect(after.rows[0]!.name_previous).toBeNull();
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // No-policy fallback (Q-NEW-F03C-4)
  // ─────────────────────────────────────────────────────────────────

  describe('default-when-absent fallback', () => {
    it('tenant with no tenant.scd row uses Type 2 default behavior', async () => {
      const tenantId = await makeTenant(pgPool, `tdefault-${randomUUID()}`);
      try {
        // No insertScdPolicy call — tenant has no tenant.scd row.
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'orig') RETURNING id`,
          [tenantId],
        );
        const origId = inserted.rows[0]!.id;
        await new Promise((r) => setTimeout(r, 5));

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'rotated' WHERE id = $1`, [origId]);
        });

        const all = await pgPool.query<{ id: string; txn_upper: string | null }>(
          `SELECT id, upper(txn_time)::text AS txn_upper FROM ${MAIN_TABLE}
           WHERE tenant_id = $1 ORDER BY upper(txn_time) NULLS LAST`,
          [tenantId],
        );
        // Type 2 row rotation: 2 rows, OLD closed, NEW open.
        expect(all.rows).toHaveLength(2);
        expect(all.rows[0]!.txn_upper).not.toBeNull();
        expect(all.rows[1]!.txn_upper).toBeNull();
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // F04 lifecycle integration end-to-end
  // ─────────────────────────────────────────────────────────────────

  describe('F04 lifecycle integration', () => {
    afterEach(() => {
      // Re-register the SCD policy schema after any reset performed
      // by a sub-test (resetSchemaRegistry is called in scd-policy
      // tests; running them in the same vitest workspace clears the
      // registry mid-suite).
      resetSchemaRegistry();
      registerNamespaceSchema(SCD_POLICY_NAMESPACE, SCDPolicySchema, {
        version: SCD_POLICY_SCHEMA_VERSION,
      });
    });

    it('createDraft → validateDraft → promoteDraft → trigger picks up new policy', async () => {
      const tenantId = await makeTenant(pgPool, `tlifecycle-${randomUUID()}`);
      const db: NodePgDatabase<Record<string, never>> = drizzle(testPool);
      try {
        // Ensure the schema is registered (idempotent).
        registerNamespaceSchema(SCD_POLICY_NAMESPACE, SCDPolicySchema, {
          version: SCD_POLICY_SCHEMA_VERSION,
        });

        // Initial state: no SCD policy → Type 2 default.
        // Promote a Type 1 policy via F04 lifecycle.
        const draft = await createDraft(db, {
          tenantId,
          namespace: SCD_POLICY_NAMESPACE,
          schemaVersion: SCD_POLICY_SCHEMA_VERSION,
          draftJson: { [MAIN_TABLE]: { type: 1 } },
          actor: userActor,
        });
        const validated = await validateDraft(db, tenantId, {
          draftId: draft.id,
          actor: userActor,
        });
        expect(validated.valid).toBe(true);

        const promoted = await promoteDraft(db, tenantId, {
          draftId: draft.id,
          actor: userActor,
        });
        expect(promoted.versionNumber).toBeGreaterThan(0);

        // Now an UPDATE on MAIN_TABLE should follow Type 1 (in-place;
        // no row rotation; id stable).
        const inserted = await pgPool.query<{ id: string }>(
          `INSERT INTO ${MAIN_TABLE} (tenant_id, name) VALUES ($1, 'pre') RETURNING id`,
          [tenantId],
        );
        const origId = inserted.rows[0]!.id;

        await withTenantContext(testPool, tenantId, async (tx) => {
          await tx.query(`UPDATE ${MAIN_TABLE} SET name = 'post' WHERE id = $1`, [origId]);
        });

        const after = await pgPool.query<{ id: string; name: string }>(
          `SELECT id, name FROM ${MAIN_TABLE} WHERE tenant_id = $1`,
          [tenantId],
        );
        expect(after.rows).toHaveLength(1);
        expect(after.rows[0]!.id).toBe(origId);
        expect(after.rows[0]!.name).toBe('post');
      } finally {
        await pgPool.query(`DELETE FROM ${MAIN_TABLE} WHERE tenant_id = $1`, [tenantId]);
        await cleanupTenantPlaneState(pgPool, tenantId);
        await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
      }
    });
  });
});

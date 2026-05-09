/**
 * Tests for cortex.backfill_bitemporal (F03 Slice A migration 0013).
 *
 * Per scope-doc SD3 (PL/pgSQL function in cortex schema; idempotent).
 * Creates a synthetic legacy table without bi-temporal columns, invokes
 * the function, asserts post-state (columns + trigger + indexes +
 * exclusion). Re-runs; asserts idempotency (no-op on second call).
 *
 * Cleanup: DROP TABLE in afterAll. Test runs against the same ephemeral
 * Postgres the existing foundation tests use (CI: pgvector/pgvector:pg17
 * service container per ci.yaml).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const { Pool } = pg;

const TEST_TABLE = 'f03_a_synthetic_legacy';

describe('cortex.backfill_bitemporal', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'postgres',
      password: process.env.PGPASSWORD ?? '',
      database: process.env.PGDATABASE ?? 'cortex',
    });
    // Ensure clean slate (in case a prior failing run left the table).
    await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
    await pool.query(`
      CREATE TABLE ${TEST_TABLE} (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        external_sku text NOT NULL,
        name         text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
    await pool.end();
  });

  it('adds bi-temporal columns + trigger + indexes + exclusion to a legacy table', async () => {
    await pool.query(`SELECT cortex.backfill_bitemporal('public', $1, 'external_sku')`, [
      TEST_TABLE,
    ]);

    // Columns exist.
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TEST_TABLE],
    );
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames).toContain('valid_time');
    expect(colNames).toContain('txn_time');

    // Trigger exists with the expected binding.
    const trg = await pool.query<{ tgname: string; tgtype: number }>(
      `SELECT tgname, tgtype FROM pg_trigger
       WHERE tgrelid = ($1::regclass) AND NOT tgisinternal`,
      [TEST_TABLE],
    );
    expect(trg.rows.length).toBeGreaterThan(0);
    expect(trg.rows.find((r) => r.tgname === `${TEST_TABLE}_scd`)).toBeDefined();

    // Exclusion constraint.
    const excl = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = ($1::regclass) AND contype = 'x'`,
      [TEST_TABLE],
    );
    expect(
      excl.rows.find((r) => r.conname === `${TEST_TABLE}_business_key_no_overlap`),
    ).toBeDefined();

    // GiST + tenant-current indexes.
    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
      [TEST_TABLE],
    );
    const idxNames = idx.rows.map((r) => r.indexname);
    expect(idxNames).toContain(`${TEST_TABLE}_temporal_gist`);
    expect(idxNames).toContain(`${TEST_TABLE}_tenant_current`);
  });

  it('is idempotent: re-running on a backfilled table is a no-op', async () => {
    // Second call should not throw + should preserve all state.
    const beforeCols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TEST_TABLE],
    );

    await pool.query(`SELECT cortex.backfill_bitemporal('public', $1, 'external_sku')`, [
      TEST_TABLE,
    ]);

    const afterCols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TEST_TABLE],
    );
    expect(afterCols.rows.length).toBe(beforeCols.rows.length);
  });
});

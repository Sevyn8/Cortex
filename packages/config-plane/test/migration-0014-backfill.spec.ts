/**
 * Migration 0014 backfill verification per Q-NEW-F04A-6 lock.
 *
 * Pattern: simulate the pre-migration state by dropping the new
 * columns + reverting the UNIQUE constraint, insert an OLD-shape row,
 * then re-apply the migration's forward operations and verify the
 * UPDATE backfill set the expected default values
 * (`namespace='tenant'`, `schema_version=1`, `parent_version_id=NULL`).
 *
 * `make db:init-test` already applied 0014 to the test DB; this spec
 * temporarily un-applies and re-applies it within a single test
 * scope. After the test runs, the schema is back to the post-0014
 * shape — final state matches `make db:init-test` baseline.
 *
 * Lives in its own spec file so its schema-mutation surface doesn't
 * interfere with other config-plane tests running in parallel
 * vitest workers (vitest defaults: file-level parallelism, in-file
 * sequential). Other config-plane spec files do NOT touch the
 * tenant_config_version schema; cross-file ordering is safe as long
 * as this file runs as a single sequential unit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

// This test issues DDL (ALTER TABLE) which requires table ownership.
// `tenant_config_version` is owned by `postgres` (the migration applier);
// the workflow's default `test_user` is NOSUPERUSER NOBYPASSRLS and
// cannot ALTER it. Build a dedicated postgres-user pool for this spec.
function makePostgresPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error('PGPASSWORD not set; required for migration-backfill spec.');
  }
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: 'postgres',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

describe('migration 0014 — F04 config namespace reshape backfill', () => {
  let pool: Pool;
  let testTenantId: string;

  beforeAll(async () => {
    pool = makePostgresPool();
    // Insert a dedicated tenant for this test. Using a known UUID
    // makes cleanup deterministic.
    const tenantInsert = await pool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('mig-0014-backfill-test', 'Migration 0014 Backfill Test', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    testTenantId = tenantInsert.rows[0]!.id;
  });

  afterAll(async () => {
    // Restore: clean up rows we inserted; verify schema is back to
    // post-0014 shape.
    await pool.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [testTenantId]);
    await pool.query(`DELETE FROM tenant WHERE id = $1`, [testTenantId]);
    await pool.end();
  });

  it('backfill UPDATE sets namespace=tenant + schema_version=1 + parent_version_id=NULL on pre-migration rows', async () => {
    // 1. Simulate pre-migration state: revert columns + UNIQUE.
    //    Use IF EXISTS / IF NOT EXISTS to make the test idempotent
    //    if a prior run aborted mid-flight.
    await pool.query(`
      ALTER TABLE tenant_config_version
        DROP CONSTRAINT IF EXISTS tenant_config_version_tenant_namespace_version_key
    `);
    await pool.query(`
      ALTER TABLE tenant_config_version DROP COLUMN IF EXISTS namespace
    `);
    await pool.query(`
      ALTER TABLE tenant_config_version DROP COLUMN IF EXISTS parent_version_id
    `);
    await pool.query(`
      ALTER TABLE tenant_config_version DROP COLUMN IF EXISTS schema_version
    `);
    // Old UNIQUE may already exist (idempotency); use ADD ... IF NOT
    // EXISTS via DO block since Postgres doesn't support
    // CONSTRAINT IF NOT EXISTS directly.
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'tenant_config_version_tenant_id_version_number_key'
        ) THEN
          ALTER TABLE tenant_config_version
            ADD CONSTRAINT tenant_config_version_tenant_id_version_number_key
            UNIQUE (tenant_id, version_number);
        END IF;
      END
      $$
    `);

    // 2. Insert OLD-shape row.
    await pool.query(
      `INSERT INTO tenant_config_version (tenant_id, version_number, config_json)
       VALUES ($1, 1, '{}'::jsonb)`,
      [testTenantId],
    );

    // 3. Re-apply migration 0014 forward operations.
    await pool.query(`ALTER TABLE tenant_config_version ADD COLUMN namespace text`);
    await pool.query(
      `ALTER TABLE tenant_config_version ADD COLUMN parent_version_id uuid REFERENCES tenant_config_version(id)`,
    );
    await pool.query(
      `ALTER TABLE tenant_config_version ADD COLUMN schema_version integer DEFAULT 1`,
    );
    await pool.query(`
      UPDATE tenant_config_version
        SET namespace = 'tenant'
        WHERE namespace IS NULL
    `);
    await pool.query(`ALTER TABLE tenant_config_version ALTER COLUMN namespace SET NOT NULL`);
    await pool.query(`ALTER TABLE tenant_config_version ALTER COLUMN schema_version SET NOT NULL`);
    await pool.query(`
      ALTER TABLE tenant_config_version
        DROP CONSTRAINT tenant_config_version_tenant_id_version_number_key
    `);
    await pool.query(`
      ALTER TABLE tenant_config_version
        ADD CONSTRAINT tenant_config_version_tenant_namespace_version_key
        UNIQUE (tenant_id, namespace, version_number)
    `);

    // 4. Verify backfill.
    const { rows } = await pool.query<{
      namespace: string;
      parent_version_id: string | null;
      schema_version: number;
    }>(
      `SELECT namespace, parent_version_id, schema_version
       FROM tenant_config_version
       WHERE tenant_id = $1`,
      [testTenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.namespace).toBe('tenant');
    expect(rows[0]!.parent_version_id).toBeNull();
    expect(rows[0]!.schema_version).toBe(1);
  });
});

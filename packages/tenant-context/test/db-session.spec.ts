import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ZodError } from 'zod';
import { bindTenantToDbSession, ensureBoundToTenant } from '../src/db-session.js';
import { withTenantContext } from '../src/context.js';
import { TenantContextMissingError, TenantValidationError } from '../src/errors.js';
import { getPool, withBoundClient } from './helpers/db.js';

const TENANT_ID = '99999999-9999-4999-8999-999999999999';
const TENANT_EXTERNAL_ID = 'test-dbsession-tenant';

describe('db-session', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;

  beforeAll(async () => {
    pool = getPool();
    db = drizzle(pool);

    // Pre-existing test rows from earlier runs would block constraints;
    // clean any stragglers first. tenant_config_version is RLS-protected,
    // so DELETE there must run with app.tenant_id bound.
    await withBoundClient(pool, TENANT_ID, async (client) => {
      await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [TENANT_ID]);
    });
    await pool.query('DELETE FROM tenant WHERE id = $1', [TENANT_ID]);

    // Insert the test tenant (control plane — no RLS on tenant table).
    await pool.query(
      `INSERT INTO tenant (id, external_id, display_name, tier)
         VALUES ($1, $2, $3, 'STANDARD')`,
      [TENANT_ID, TENANT_EXTERNAL_ID, 'DB-Session Test Tenant'],
    );
  });

  afterAll(async () => {
    await withBoundClient(pool, TENANT_ID, async (client) => {
      await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [TENANT_ID]);
    });
    await pool.query('DELETE FROM tenant WHERE id = $1', [TENANT_ID]);
    await pool.end();
  });

  it('bindTenantToDbSession sets app.tenant_id correctly', async () => {
    const observed = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      const result = await tx.execute<{ value: string | null }>(
        sql`SELECT current_setting('app.tenant_id', true) AS value`,
      );
      return result.rows[0]?.value ?? null;
    });
    expect(observed).toBe(TENANT_ID);
  });

  it('rejects an invalid UUID with TenantValidationError + ZodError cause', async () => {
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, 'not-a-uuid');
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(TenantValidationError);
    expect((captured as TenantValidationError).cause).toBeInstanceOf(ZodError);
  });

  it('binding is transaction-scoped: vanishes after txn ends', async () => {
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      const inside = await tx.execute<{ value: string | null }>(
        sql`SELECT current_setting('app.tenant_id', true) AS value`,
      );
      expect(inside.rows[0]?.value).toBe(TENANT_ID);
    });

    // Outside any transaction. set_config(..., true) is local to its txn,
    // so the value should now be empty.
    const outside = await db.execute<{ value: string | null }>(
      sql`SELECT current_setting('app.tenant_id', true) AS value`,
    );
    expect(outside.rows[0]?.value).toBe('');
  });

  it('ensureBoundToTenant reads from async context and binds correctly', async () => {
    const observed = await withTenantContext(TENANT_ID, async () => {
      return db.transaction(async (tx) => {
        await ensureBoundToTenant(tx);
        const result = await tx.execute<{ value: string | null }>(
          sql`SELECT current_setting('app.tenant_id', true) AS value`,
        );
        return result.rows[0]?.value ?? null;
      });
    });
    expect(observed).toBe(TENANT_ID);
  });

  it('ensureBoundToTenant throws TenantContextMissingError when no async context', async () => {
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await ensureBoundToTenant(tx);
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(TenantContextMissingError);
  });

  it('binding makes RLS policies fire on tenant_config_version', async () => {
    // Without bind: the fail-closed cortex.current_tenant_id() reader
    // raises 42501 when app.tenant_id is unset.
    let unboundFailure: { code?: string; message?: string } | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`INSERT INTO tenant_config_version (tenant_id, version_number, config_json)
              VALUES (${TENANT_ID}, 100, '{}'::jsonb)`,
        );
      });
    } catch (err) {
      unboundFailure = err as { code?: string; message?: string };
    }
    expect(unboundFailure).toBeDefined();
    expect(unboundFailure?.code).toBe('42501');

    // With bind: insert succeeds.
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await tx.execute(
        sql`INSERT INTO tenant_config_version (tenant_id, version_number, config_json)
            VALUES (${TENANT_ID}, 101, '{"k":"v"}'::jsonb)`,
      );
    });

    // Verify the row landed (SELECT also hits RLS — bind first).
    const verifyCount = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      const result = await tx.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM tenant_config_version
              WHERE tenant_id = ${TENANT_ID} AND version_number = 101`,
      );
      return result.rows[0]?.count ?? null;
    });
    expect(verifyCount).toBe('1');
  });
});

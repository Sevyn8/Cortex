import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ZodError } from 'zod';
import {
  bindTenantToDbSession,
  ensureBoundToTenant,
  withTenantDbClient,
} from '../src/db-session.js';
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
          sql`INSERT INTO tenant_config_version (tenant_id, namespace, version_number, config_json)
              VALUES (${TENANT_ID}, 'tenant', 100, '{}'::jsonb)`,
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
        sql`INSERT INTO tenant_config_version (tenant_id, namespace, version_number, config_json)
            VALUES (${TENANT_ID}, 'tenant', 101, '{"k":"v"}'::jsonb)`,
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

  // ───────────────────────────────────────────────────────────────────
  // withTenantDbClient (planning-doc §10.4 forcing function + SA16)
  // ───────────────────────────────────────────────────────────────────

  describe('withTenantDbClient', () => {
    it('runs callback with a bound transaction; commits; propagates return value', async () => {
      const observed = await withTenantDbClient(pool, TENANT_ID, async (tx) => {
        const result = await tx.execute<{ value: string | null }>(
          sql`SELECT current_setting('app.tenant_id', true) AS value`,
        );
        return result.rows[0]?.value ?? null;
      });
      expect(observed).toBe(TENANT_ID);
    });

    it('rolls back the transaction when the callback throws (partial writes undone)', async () => {
      // Use a fresh version_number that won't collide with prior tests.
      const VERSION = 7777;

      let captured: unknown;
      try {
        await withTenantDbClient(pool, TENANT_ID, async (tx) => {
          await tx.execute(
            sql`INSERT INTO tenant_config_version (tenant_id, namespace, version_number, config_json)
                VALUES (${TENANT_ID}, 'tenant', ${VERSION}, '{"forced":"rollback"}'::jsonb)`,
          );
          throw new Error('forced rollback');
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toBe('forced rollback');

      // Verify the INSERT was rolled back (RLS-bound SELECT).
      const count = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, TENANT_ID);
        const result = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM tenant_config_version
                WHERE tenant_id = ${TENANT_ID} AND version_number = ${VERSION}`,
        );
        return result.rows[0]?.count ?? null;
      });
      expect(count).toBe('0');
    });

    it('rejects a non-UUID tenantId BEFORE acquiring a pool connection (fail-fast)', async () => {
      let captured: unknown;
      const beforeTotal = pool.totalCount;
      try {
        await withTenantDbClient(pool, 'not-a-uuid', () => Promise.resolve('never reached'));
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantValidationError);
      expect((captured as TenantValidationError).cause).toBeInstanceOf(ZodError);
      // Pool's totalCount should not have grown — validation happened
      // before any connect() call.
      expect(pool.totalCount).toBe(beforeTotal);
    });

    it('returns the connection to the pool on callback success', async () => {
      // Drive a few calls; verify in-use count returns to zero each time.
      for (let i = 0; i < 3; i++) {
        await withTenantDbClient(pool, TENANT_ID, () => Promise.resolve(i));
        // pool.totalCount - pool.idleCount = "checked-out" (in-use) connections.
        // After the txn commits + connection is released, in-use returns to 0.
        expect(pool.totalCount - pool.idleCount).toBe(0);
      }
    });

    it('returns the connection to the pool on callback throw', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await withTenantDbClient(pool, TENANT_ID, () => Promise.reject(new Error(`boom ${i}`)));
        } catch {
          // expected
        }
        expect(pool.totalCount - pool.idleCount).toBe(0);
      }
    });

    it('binding is genuinely scoped to the callback (post-call query has empty app.tenant_id)', async () => {
      const insideValue = await withTenantDbClient(pool, TENANT_ID, async (tx) => {
        const r = await tx.execute<{ value: string | null }>(
          sql`SELECT current_setting('app.tenant_id', true) AS value`,
        );
        return r.rows[0]?.value ?? null;
      });
      expect(insideValue).toBe(TENANT_ID);

      // After the helper returns, a fresh query (no txn, no bind) sees
      // empty app.tenant_id — the bind was txn-local and didn't leak.
      const outsideValue = await db.execute<{ value: string | null }>(
        sql`SELECT current_setting('app.tenant_id', true) AS value`,
      );
      expect(outsideValue.rows[0]?.value).toBe('');
    });

    it('integrates with RLS — a tenant_config_version INSERT inside the helper succeeds', async () => {
      const VERSION = 7778;
      const result = await withTenantDbClient(pool, TENANT_ID, async (tx) => {
        await tx.execute(
          sql`INSERT INTO tenant_config_version (tenant_id, namespace, version_number, config_json)
              VALUES (${TENANT_ID}, 'tenant', ${VERSION}, '{"k":"v-via-with-tenant-db-client"}'::jsonb)`,
        );
        const r = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM tenant_config_version
                WHERE tenant_id = ${TENANT_ID} AND version_number = ${VERSION}`,
        );
        return r.rows[0]?.count ?? null;
      });
      expect(result).toBe('1');
      // Cleanup so afterAll's RLS-bound DELETE catches it.
    });

    it('different tenantIds in successive calls produce correctly-scoped binds', async () => {
      // Insert a second tenant for cross-tenant isolation testing.
      const otherTenantId = randomUUID();
      try {
        await pool.query(
          `INSERT INTO tenant (id, external_id, display_name, tier)
             VALUES ($1, $2, 'Other', 'STANDARD')`,
          [otherTenantId, `test-with-tenant-${otherTenantId.slice(0, 8)}`],
        );

        const a = await withTenantDbClient(pool, TENANT_ID, async (tx) => {
          const r = await tx.execute<{ value: string | null }>(
            sql`SELECT current_setting('app.tenant_id', true) AS value`,
          );
          return r.rows[0]?.value;
        });
        const b = await withTenantDbClient(pool, otherTenantId, async (tx) => {
          const r = await tx.execute<{ value: string | null }>(
            sql`SELECT current_setting('app.tenant_id', true) AS value`,
          );
          return r.rows[0]?.value;
        });
        expect(a).toBe(TENANT_ID);
        expect(b).toBe(otherTenantId);
      } finally {
        await pool.query('DELETE FROM tenant WHERE id = $1', [otherTenantId]);
      }
    });
  });
});

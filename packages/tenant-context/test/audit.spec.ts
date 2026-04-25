import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ZodError } from 'zod';
import { emitAuditEvent } from '../src/audit.js';
import { bindTenantToDbSession } from '../src/db-session.js';
import { TenantValidationError } from '../src/errors.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const TENANT_ID = randomUUID();
const TENANT_EXTERNAL_ID = `test-audit-${TENANT_ID.slice(0, 8)}`;

describe('audit', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;

  beforeAll(async () => {
    pool = getPool();
    db = drizzle(pool);

    await forceRlsOnAuditEvent(pool);

    // Tenant table has no RLS — direct INSERT works.
    await pool.query(
      `INSERT INTO tenant (id, external_id, display_name, tier)
         VALUES ($1, $2, $3, 'STANDARD')`,
      [TENANT_ID, TENANT_EXTERNAL_ID, 'Audit Test Tenant'],
    );
  });

  afterAll(async () => {
    // audit_event has no FK to tenant; rows orphan but are tagged to a
    // unique TENANT_ID per run, so they don't interfere with future runs.
    // DELETE on audit_event is blocked by the 2F002 trigger; we accept the
    // accumulation and keep tests parallel-file-safe.
    await pool.query('DELETE FROM tenant WHERE id = $1', [TENANT_ID]);
    await pool.end();
  });

  it('inserts a row with all 7 application fields populated', async () => {
    const params = {
      tenantId: TENANT_ID,
      actorType: 'service' as const,
      actorId: 'test-actor-1',
      actorDescription: 'unit test',
      action: 'TENANT_CREATED' as const,
      resource: `tenant:${TENANT_ID}`,
      payload: { hello: 'world' },
    };

    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, params);
    });

    const fetched = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      const result = await tx.execute<{
        tenant_id: string;
        actor_type: string;
        actor_id: string;
        actor_description: string | null;
        action: string;
        resource: string;
        payload: unknown;
      }>(
        sql`SELECT tenant_id, actor_type, actor_id, actor_description,
                   action, resource, payload
              FROM audit_event
              WHERE tenant_id = ${TENANT_ID} AND actor_id = 'test-actor-1'
              ORDER BY occurred_at DESC
              LIMIT 1`,
      );
      return result.rows[0];
    });

    expect(fetched).toBeDefined();
    expect(fetched).toMatchObject({
      tenant_id: TENANT_ID,
      actor_type: 'service',
      actor_id: 'test-actor-1',
      actor_description: 'unit test',
      action: 'TENANT_CREATED',
      resource: `tenant:${TENANT_ID}`,
      payload: { hello: 'world' },
    });
  });

  it('audit_chain trigger auto-fills prev_hash and curr_hash', async () => {
    // Use a separate tenant so we can rely on "no prior rows" semantics.
    const chainTenantId = randomUUID();
    const chainExternalId = `test-audit-chain-${chainTenantId.slice(0, 8)}`;

    await pool.query(
      `INSERT INTO tenant (id, external_id, display_name, tier)
         VALUES ($1, $2, $3, 'STANDARD')`,
      [chainTenantId, chainExternalId, 'Chain Test Tenant'],
    );

    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, chainTenantId);
        await emitAuditEvent(tx, {
          tenantId: chainTenantId,
          actorType: 'system',
          actorId: 'sys-1',
          action: 'TENANT_CREATED',
          resource: `tenant:${chainTenantId}`,
          payload: { n: 1 },
        });
      });

      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, chainTenantId);
        await emitAuditEvent(tx, {
          tenantId: chainTenantId,
          actorType: 'system',
          actorId: 'sys-1',
          action: 'TENANT_UPDATED',
          resource: `tenant:${chainTenantId}`,
          payload: { n: 2 },
        });
      });

      const rows = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, chainTenantId);
        const result = await tx.execute<{
          prev_hash: Buffer | null;
          curr_hash: Buffer;
        }>(
          sql`SELECT prev_hash, curr_hash FROM audit_event
                WHERE tenant_id = ${chainTenantId}
                ORDER BY occurred_at ASC`,
        );
        return result.rows;
      });

      expect(rows).toHaveLength(2);
      expect(rows[0]?.prev_hash).toBeNull();
      expect(Buffer.isBuffer(rows[0]?.curr_hash)).toBe(true);
      expect(rows[0]?.curr_hash.length).toBe(32);
      expect(Buffer.isBuffer(rows[1]?.prev_hash)).toBe(true);
      // Second row's prev_hash must equal first row's curr_hash.
      expect(rows[1]?.prev_hash?.equals(rows[0]!.curr_hash)).toBe(true);
    } finally {
      await pool.query('DELETE FROM tenant WHERE id = $1', [chainTenantId]);
    }
  });

  it('without bound tenant raises 42501 from RLS write policy', async () => {
    let captured: { code?: string } | undefined;
    try {
      await db.transaction(async (tx) => {
        // No bindTenantToDbSession call — RLS policy will deny the INSERT.
        await emitAuditEvent(tx, {
          tenantId: TENANT_ID,
          actorType: 'service',
          actorId: 'unbound-actor',
          action: 'TENANT_CREATED',
          resource: `tenant:${TENANT_ID}`,
          payload: {},
        });
      });
    } catch (err) {
      captured = err as { code?: string };
    }
    expect(captured?.code).toBe('42501');
  });

  it('inside a bound transaction emits successfully (row count increments)', async () => {
    const before = await countAuditRowsForActor(db, TENANT_ID, 'count-test');

    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId: 'count-test',
        action: 'TENANT_UPDATED',
        resource: `tenant:${TENANT_ID}`,
        payload: {},
      });
    });

    const after = await countAuditRowsForActor(db, TENANT_ID, 'count-test');
    expect(after - before).toBe(1);
  });

  it('invalid params throw TenantValidationError with ZodError cause', async () => {
    const cases: { label: string; params: unknown }[] = [
      {
        label: 'missing actorId',
        params: {
          tenantId: TENANT_ID,
          actorType: 'service',
          action: 'TENANT_CREATED',
          resource: `tenant:${TENANT_ID}`,
        },
      },
      {
        label: 'invalid actorType',
        params: {
          tenantId: TENANT_ID,
          actorType: 'robot',
          actorId: 'a',
          action: 'TENANT_CREATED',
          resource: `tenant:${TENANT_ID}`,
        },
      },
      {
        label: 'action not in enum',
        params: {
          tenantId: TENANT_ID,
          actorType: 'service',
          actorId: 'a',
          action: 'TENANT_OBLITERATED',
          resource: `tenant:${TENANT_ID}`,
        },
      },
    ];

    for (const c of cases) {
      let captured: unknown;
      try {
        await db.transaction(async (tx) => {
          await bindTenantToDbSession(tx, TENANT_ID);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await emitAuditEvent(tx, c.params as any);
        });
      } catch (err) {
        captured = err;
      }
      expect(captured, c.label).toBeInstanceOf(TenantValidationError);
      expect((captured as TenantValidationError).cause, c.label).toBeInstanceOf(ZodError);
    }
  });

  it('accepts all 3 actorTypes (service, user, system)', async () => {
    for (const actorType of ['service', 'user', 'system'] as const) {
      const actorId = `actor-${actorType}-1`;
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, TENANT_ID);
        await emitAuditEvent(tx, {
          tenantId: TENANT_ID,
          actorType,
          actorId,
          action: 'TENANT_CREATED',
          resource: `tenant:${TENANT_ID}`,
          payload: {},
        });
      });

      const fetched = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, TENANT_ID);
        const result = await tx.execute<{ actor_type: string }>(
          sql`SELECT actor_type FROM audit_event
                WHERE tenant_id = ${TENANT_ID} AND actor_id = ${actorId}
                ORDER BY occurred_at DESC LIMIT 1`,
        );
        return result.rows[0];
      });
      expect(fetched?.actor_type).toBe(actorType);
    }
  });

  it('actorDescription stored when supplied; NULL when omitted', async () => {
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId: 'with-desc',
        actorDescription: 'a description',
        action: 'TENANT_CREATED',
        resource: `tenant:${TENANT_ID}`,
        payload: {},
      });
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId: 'no-desc',
        action: 'TENANT_CREATED',
        resource: `tenant:${TENANT_ID}`,
        payload: {},
      });
    });

    const rows = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      const result = await tx.execute<{
        actor_id: string;
        actor_description: string | null;
      }>(
        sql`SELECT actor_id, actor_description FROM audit_event
              WHERE tenant_id = ${TENANT_ID}
                AND actor_id IN ('with-desc', 'no-desc')`,
      );
      return result.rows;
    });

    const withDesc = rows.find((r) => r.actor_id === 'with-desc');
    const noDesc = rows.find((r) => r.actor_id === 'no-desc');
    expect(withDesc?.actor_description).toBe('a description');
    expect(noDesc?.actor_description).toBeNull();
  });

  it('UPDATE on audit_event raises SQLSTATE 2F002 (append-only)', async () => {
    // Insert one row first, then attempt UPDATE inside a bound transaction.
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId: 'append-only-test',
        action: 'TENANT_CREATED',
        resource: `tenant:${TENANT_ID}`,
        payload: { tag: 'before' },
      });
    });

    let captured: { code?: string } | undefined;
    try {
      await withBoundClient(pool, TENANT_ID, async (client) => {
        await client.query(
          `UPDATE audit_event SET payload = '{"tag":"after"}'::jsonb
             WHERE tenant_id = $1 AND actor_id = $2`,
          [TENANT_ID, 'append-only-test'],
        );
      });
    } catch (err) {
      captured = err as { code?: string };
    }
    expect(captured?.code).toBe('2F002');
  });
});

async function countAuditRowsForActor(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  actorId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    const result = await tx.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM audit_event
            WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}`,
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

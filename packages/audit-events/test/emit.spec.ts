import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bindTenantToDbSession } from '@cortex/tenant-context';
import { createLogger } from '@cortex/observability';
import { createLogCapture } from '@cortex/observability/test-utils';
import {
  AuditEventEmissionError,
  AuditEventValidationError,
  __resetForTesting,
  __setEmitterForTesting,
  createAuditEventEmitter,
  emitAuditEvent,
  getActionByName,
  registerAuditActions,
  SOFT_PAYLOAD_LIMIT_BYTES,
  type AuditEventParams,
} from '../src/index.js';

// Catalog used across all integration tests.
const TEST_ACTIONS = registerAuditActions([
  { name: 'TEST_CREATE', verb: 'CREATE' },
  { name: 'TEST_READ', verb: 'READ' },
  { name: 'TEST_UPDATE', verb: 'UPDATE' },
  { name: 'TEST_REMOVED', verb: 'DELETE' },
] as const);

// One tenant id for the file-run; sub-tests that need clean chain
// semantics (no prior rows in the per-tenant chain) generate their own.
const TENANT_ID = randomUUID();

let pool: Pool;
let db: NodePgDatabase<Record<string, never>>;

beforeAll(async () => {
  pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? 'test_user',
    password: process.env.PGPASSWORD ?? 'testpw',
    database: process.env.PGDATABASE ?? 'cortex',
  });
  db = drizzle(pool);
  // audit_event is owned by test_user in p09-repro; without FORCE the
  // owner bypasses RLS, which makes the unbound-emit RLS-denial test
  // silently pass. Idempotent. (Mirrors tenant-context test fixture.)
  await pool.query('ALTER TABLE audit_event FORCE ROW LEVEL SECURITY');
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────
// Group: emitAuditEvent happy path
// ─────────────────────────────────────────────────────────────────────

describe('emitAuditEvent — happy path', () => {
  it('CREATE: lands in audit_event with expected columns and payload.after_state', async () => {
    const actorId = `create-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId,
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${TENANT_ID}`,
        after_state: { foo: 'bar' },
      });
    });

    const fetched = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      const result = await tx.execute<{
        tenant_id: string;
        actor_type: string;
        actor_id: string;
        action: string;
        resource: string;
        payload: Record<string, unknown>;
      }>(
        sql`SELECT tenant_id, actor_type, actor_id, action, resource, payload
              FROM audit_event
              WHERE tenant_id = ${TENANT_ID} AND actor_id = ${actorId}`,
      );
      return result.rows[0];
    });

    expect(fetched).toMatchObject({
      tenant_id: TENANT_ID,
      actor_type: 'service',
      actor_id: actorId,
      action: 'TEST_CREATE',
      resource: `tenant:${TENANT_ID}`,
    });
    expect(fetched?.payload.after_state).toEqual({ foo: 'bar' });
    expect(fetched?.payload.before_state).toBeUndefined();
  });

  it('UPDATE: payload contains both before_state and after_state', async () => {
    const actorId = `update-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'user',
        actorId,
        action: getActionByName(TEST_ACTIONS, 'TEST_UPDATE'),
        verb: 'UPDATE',
        resource: `tenant:${TENANT_ID}`,
        before_state: { status: 'PROVISIONING' },
        after_state: { status: 'ACTIVE' },
      });
    });

    const payload = await selectPayload(actorId);
    expect(payload?.before_state).toEqual({ status: 'PROVISIONING' });
    expect(payload?.after_state).toEqual({ status: 'ACTIVE' });
  });

  it('DELETE: payload contains before_state, no after_state', async () => {
    const actorId = `delete-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId,
        action: getActionByName(TEST_ACTIONS, 'TEST_REMOVED'),
        verb: 'DELETE',
        resource: `tenant:${TENANT_ID}`,
        before_state: { tier: 'STANDARD' },
      });
    });

    const payload = await selectPayload(actorId);
    expect(payload?.before_state).toEqual({ tier: 'STANDARD' });
    expect(payload?.after_state).toBeUndefined();
  });

  it('READ: payload has neither before_state nor after_state', async () => {
    const actorId = `read-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'agent',
        actorId,
        action: getActionByName(TEST_ACTIONS, 'TEST_READ'),
        verb: 'READ',
        resource: `tenant:${TENANT_ID}`,
      });
    });

    const payload = await selectPayload(actorId);
    expect(payload).toBeDefined();
    expect(payload?.before_state).toBeUndefined();
    expect(payload?.after_state).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Decision 11 — clock_timestamp() uniqueness
// ─────────────────────────────────────────────────────────────────────

describe('Decision 11 — same-transaction emits get distinct occurred_at', () => {
  it('two sequential emits in one transaction produce distinct occurred_at values', async () => {
    // Fresh tenant — no prior rows so chain semantics are clean.
    const chainTenantId = randomUUID();
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, chainTenantId);
      await emitAuditEvent(tx, {
        tenantId: chainTenantId,
        actorType: 'service',
        actorId: 'seq-1',
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${chainTenantId}`,
        after_state: { n: 1 },
      });
      await emitAuditEvent(tx, {
        tenantId: chainTenantId,
        actorType: 'service',
        actorId: 'seq-2',
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${chainTenantId}`,
        after_state: { n: 2 },
      });
    });

    const rows = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, chainTenantId);
      const result = await tx.execute<{
        actor_id: string;
        occurred_at: string;
      }>(
        sql`SELECT actor_id, occurred_at::text AS occurred_at FROM audit_event
              WHERE tenant_id = ${chainTenantId}
              ORDER BY occurred_at ASC`,
      );
      return result.rows;
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.occurred_at).toBeDefined();
    expect(rows[1]?.occurred_at).toBeDefined();
    // clock_timestamp() returns wall time per call → distinct within the txn
    // (now() would tie both at transaction-start time, fork the chain).
    // Cast occurred_at to text via SELECT to preserve µs precision; pg's
    // default Date conversion would truncate to ms.
    expect(rows[0]?.occurred_at).not.toBe(rows[1]?.occurred_at);
  });

  it('chain integrity holds for same-txn sequential emits — row2.prev_hash === row1.curr_hash', async () => {
    const chainTenantId = randomUUID();
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, chainTenantId);
      await emitAuditEvent(tx, {
        tenantId: chainTenantId,
        actorType: 'system',
        actorId: 'chain-1',
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${chainTenantId}`,
        after_state: { step: 1 },
      });
      await emitAuditEvent(tx, {
        tenantId: chainTenantId,
        actorType: 'system',
        actorId: 'chain-2',
        action: getActionByName(TEST_ACTIONS, 'TEST_UPDATE'),
        verb: 'UPDATE',
        resource: `tenant:${chainTenantId}`,
        before_state: { step: 1 },
        after_state: { step: 2 },
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
    expect(rows[0]?.prev_hash).toBeNull(); // genesis
    expect(Buffer.isBuffer(rows[0]?.curr_hash)).toBe(true);
    expect(rows[0]?.curr_hash.length).toBe(32);
    expect(Buffer.isBuffer(rows[1]?.prev_hash)).toBe(true);
    // The Decision 11 invariant: same-txn chain links cleanly.
    expect(rows[1]?.prev_hash?.equals(rows[0]!.curr_hash)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: RLS enforcement
// ─────────────────────────────────────────────────────────────────────

describe('RLS enforcement', () => {
  it('emitAuditEvent without bindTenantToDbSession throws AuditEventEmissionError mentioning RLS / 42501', async () => {
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        // No bindTenantToDbSession — RLS write policy denies.
        await emitAuditEvent(tx, {
          tenantId: TENANT_ID,
          actorType: 'service',
          actorId: `rls-denied-${randomUUID().slice(0, 8)}`,
          action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
          verb: 'CREATE',
          resource: `tenant:${TENANT_ID}`,
          after_state: {},
        });
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(AuditEventEmissionError);
    expect((captured as Error).message).toMatch(/42501|RLS|tenant binding/i);
    // Cause is the raw pg error with code='42501'.
    const cause = (captured as { cause?: { code?: unknown } }).cause;
    expect(cause?.code).toBe('42501');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Validation failures
// ─────────────────────────────────────────────────────────────────────

describe('validation failures', () => {
  it('bad UUID tenantId throws AuditEventValidationError (no row inserted)', async () => {
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, TENANT_ID);
        await emitAuditEvent(tx, {
          tenantId: 'not-a-uuid',
          actorType: 'service',
          actorId: 'bad-uuid-test',
          action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
          verb: 'CREATE',
          resource: 'tenant',
          after_state: {},
        });
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AuditEventValidationError);
    expect((captured as { cause?: unknown }).cause).toBeDefined();
  });

  it('schema mismatch (CREATE with before_state) throws AuditEventValidationError before INSERT', async () => {
    const actorId = `mismatch-${randomUUID().slice(0, 8)}`;
    let captured: unknown;
    try {
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, TENANT_ID);
        // Cast to bypass the discriminated-union compile-time forbidance.
        const badParams = {
          tenantId: TENANT_ID,
          actorType: 'service',
          actorId,
          action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
          verb: 'CREATE',
          resource: 'tenant',
          after_state: { x: 1 },
          before_state: { x: 0 }, // forbidden under CREATE
        } as unknown as AuditEventParams;
        await emitAuditEvent(tx, badParams);
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AuditEventValidationError);

    // Verify no row was inserted.
    const count = await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      const r = await tx.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM audit_event
              WHERE tenant_id = ${TENANT_ID} AND actor_id = ${actorId}`,
      );
      return Number(r.rows[0]?.count ?? '0');
    });
    expect(count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Payload size warning
// ─────────────────────────────────────────────────────────────────────

describe('payload size warning', () => {
  it('payload > 64 KB triggers logger.warn but emit succeeds', async () => {
    const capture = createLogCapture();
    __setEmitterForTesting(
      createAuditEventEmitter({
        logger: createLogger({ moduleId: 'cortex-audit-events', destination: capture }),
      }),
    );
    try {
      const actorId = `oversize-${randomUUID().slice(0, 8)}`;
      const big = 'x'.repeat(70_000);
      await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, TENANT_ID);
        await emitAuditEvent(tx, {
          tenantId: TENANT_ID,
          actorType: 'service',
          actorId,
          action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
          verb: 'CREATE',
          resource: `tenant:${TENANT_ID}`,
          after_state: { big },
        });
      });
      await capture.flush();

      const warn = capture.logs.find(
        (line) =>
          typeof line.payload_size_bytes === 'number' &&
          line.payload_size_bytes > SOFT_PAYLOAD_LIMIT_BYTES,
      );
      expect(warn).toBeDefined();
      expect(warn?.severity).toBe('WARNING');
      expect(warn?.action_name).toBe('TEST_CREATE');

      // The row WAS inserted — soft warn does not block emission.
      const count = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, TENANT_ID);
        const r = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM audit_event
                WHERE tenant_id = ${TENANT_ID} AND actor_id = ${actorId}`,
        );
        return Number(r.rows[0]?.count ?? '0');
      });
      expect(count).toBe(1);
    } finally {
      __resetForTesting();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: NFC end-to-end
// ─────────────────────────────────────────────────────────────────────

describe('NFC normalization end-to-end', () => {
  it('decomposed string in payload → persisted in NFC-composed form', async () => {
    const decomposed = 'cafe\u0301'; // 5 codepoints (NFD)
    const composed = 'caf\u00e9'; // 4 codepoints (NFC)
    const actorId = `nfc-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId,
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${TENANT_ID}`,
        after_state: { name: decomposed },
      });
    });

    const payload = await selectPayload(actorId);
    const after = payload?.after_state as Record<string, unknown> | undefined;
    const persisted = after?.name as string | undefined;
    expect(persisted).toBe(composed);
    expect(persisted).toHaveLength(4);
    expect(persisted?.normalize('NFC')).toBe(persisted);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Group: Hybrid DI escape hatches
// ─────────────────────────────────────────────────────────────────────

describe('hybrid DI escape hatches', () => {
  it('__setEmitterForTesting then __resetForTesting swap and restore the default', async () => {
    const capture = createLogCapture();
    __setEmitterForTesting(
      createAuditEventEmitter({
        logger: createLogger({ moduleId: 'cortex-audit-events', destination: capture }),
      }),
    );

    // Trigger a warn through the swapped emitter.
    const actorId = `swap-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId,
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${TENANT_ID}`,
        after_state: { big: 'x'.repeat(70_000) },
      });
    });
    await capture.flush();
    expect(capture.logs.some((l) => typeof l.payload_size_bytes === 'number')).toBe(true);

    __resetForTesting();
    // After reset, the default emitter is back in place — no easy way to
    // assert "default routes elsewhere" without intercepting stdout, but
    // the next emit should not append to our (now-detached) capture.
    const lengthBeforeNextEmit = capture.logs.length;
    const actorId2 = `post-reset-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await emitAuditEvent(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId: actorId2,
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${TENANT_ID}`,
        after_state: { big: 'x'.repeat(70_000) },
      });
    });
    await capture.flush();
    expect(capture.logs.length).toBe(lengthBeforeNextEmit);
  });

  it('createAuditEventEmitter({ logger }) routes warn through the supplied logger', async () => {
    const capture = createLogCapture();
    const customEmitter = createAuditEventEmitter({
      logger: createLogger({ moduleId: 'cortex-audit-events', destination: capture }),
    });

    const actorId = `custom-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await bindTenantToDbSession(tx, TENANT_ID);
      await customEmitter.emit(tx, {
        tenantId: TENANT_ID,
        actorType: 'service',
        actorId,
        action: getActionByName(TEST_ACTIONS, 'TEST_CREATE'),
        verb: 'CREATE',
        resource: `tenant:${TENANT_ID}`,
        after_state: { big: 'x'.repeat(70_000) },
      });
    });
    await capture.flush();

    const warn = capture.logs.find((line) => typeof line.payload_size_bytes === 'number');
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('WARNING');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Helper — read a payload back by actor_id (uses TENANT_ID).
// ─────────────────────────────────────────────────────────────────────

async function selectPayload(actorId: string): Promise<Record<string, unknown> | undefined> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, TENANT_ID);
    const result = await tx.execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM audit_event
            WHERE tenant_id = ${TENANT_ID} AND actor_id = ${actorId}
            ORDER BY occurred_at DESC LIMIT 1`,
    );
    return result.rows[0]?.payload;
  });
}

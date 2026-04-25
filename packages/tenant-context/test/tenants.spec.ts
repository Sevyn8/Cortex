import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ZodError } from 'zod';
import { tenants } from '../src/tenants.js';
import { TenantNotFoundError, TenantStatusError, TenantValidationError } from '../src/errors.js';
import { bindTenantToDbSession } from '../src/db-session.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

// ─────────────────────────────────────────────────────────────────────
// Module-level mock setup. tenants.ts imports emitAuditEvent from
// ./audit.js; we replace that module with one whose emitAuditEvent is a
// vi.fn() that delegates to the real implementation by default. The
// atomicity test overrides per-call behavior via mockImplementationOnce.
// ─────────────────────────────────────────────────────────────────────

const { emitAuditEventSpy } = vi.hoisted(() => ({
  emitAuditEventSpy: vi.fn(),
}));

vi.mock('../src/audit.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/audit.js')>();
  emitAuditEventSpy.mockImplementation(actual.emitAuditEvent);
  return { ...actual, emitAuditEvent: emitAuditEventSpy };
});

// ─────────────────────────────────────────────────────────────────────
// Per-run prefix so this run's rows don't collide with prior-run rows
// (audit_event rows accumulate; tenant rows are deleted in afterAll).
// ─────────────────────────────────────────────────────────────────────

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = { type: 'service' as const, id: 'tenants-spec', description: 'CRUD test' };

describe('tenants CRUD', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    pool = getPool();
    db = drizzle(pool);
    await forceRlsOnAuditEvent(pool);
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      try {
        await withBoundClient(pool, id, async (client) => {
          await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [id]);
        });
      } catch {
        // tenant may not exist (e.g., atomicity test rolled back); ignore.
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function trackTenant(id: string) {
    createdTenantIds.push(id);
  }

  function externalIdFor(label: string): string {
    return `test-tenants-${RUN_TAG}-${label}`;
  }

  // ───────────────────────────────────────────────────────────────────
  // create
  // ───────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('happy path: returns full row, status defaults to PROVISIONING, emits TENANT_CREATED', async () => {
      const externalId = externalIdFor('create-happy');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'Happy Path', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      expect(created.external_id).toBe(externalId);
      expect(created.display_name).toBe('Happy Path');
      expect(created.tier).toBe('STANDARD');
      expect(created.status).toBe('PROVISIONING');
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

      const events = await fetchAuditEvents(db, created.id);
      expect(events.map((e) => e.action)).toEqual(['TENANT_CREATED']);
      expect(events[0]?.payload).toMatchObject({
        external_id: externalId,
        display_name: 'Happy Path',
        tier: 'STANDARD',
        status: 'PROVISIONING',
      });
    });

    it('with initialConfig also emits TENANT_CONFIG_VERSION_CREATED, ordered after TENANT_CREATED', async () => {
      const externalId = externalIdFor('create-with-config');
      const created = await tenants.create(
        db,
        {
          externalId,
          displayName: 'With Config',
          tier: 'STANDARD',
          initialConfig: { feature_flags: { x: true } },
        },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      const events = await fetchAuditEvents(db, created.id);
      expect(events.map((e) => e.action)).toEqual([
        'TENANT_CREATED',
        'TENANT_CONFIG_VERSION_CREATED',
      ]);
      expect(events[1]?.payload).toMatchObject({
        version_number: 1,
        config: { feature_flags: { x: true } },
      });

      // Both events landed in the same per-tenant chain — verify config
      // version row exists with version_number = 1.
      const configCount = await db.transaction(async (tx) => {
        await bindTenantToDbSession(tx, created.id);
        const result = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM tenant_config_version
                WHERE tenant_id = ${created.id} AND version_number = 1`,
        );
        return result.rows[0]?.count ?? null;
      });
      expect(configCount).toBe('1');
    });

    it('two events committed atomically — both rows visible after the txn', async () => {
      const externalId = externalIdFor('create-atomic-commit');
      const created = await tenants.create(
        db,
        {
          externalId,
          displayName: 'Atomic Commit',
          tier: 'STANDARD',
          initialConfig: { ok: 1 },
        },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      const tenantRow = await tenants.get(db, created.id);
      expect(tenantRow.id).toBe(created.id);

      const events = await fetchAuditEvents(db, created.id);
      expect(events).toHaveLength(2);
      // occurred_at is server-defaulted to now() per row, so they should
      // be monotonically non-decreasing in insertion order.
      const t0 = new Date(events[0]!.occurred_at).getTime();
      const t1 = new Date(events[1]!.occurred_at).getTime();
      expect(t1).toBeGreaterThanOrEqual(t0);
    });

    it('duplicate external_id raises Postgres unique-violation (23505)', async () => {
      const externalId = externalIdFor('create-dup');
      const first = await tenants.create(
        db,
        { externalId, displayName: 'Original', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(first.id);

      let captured: { code?: string } | undefined;
      try {
        await tenants.create(
          db,
          { externalId, displayName: 'Duplicate', tier: 'STANDARD' },
          { actor: ACTOR },
        );
      } catch (err) {
        captured = err as { code?: string };
      }
      expect(captured?.code).toBe('23505');
    });

    it('invalid external_id (regex fail) throws TenantValidationError', async () => {
      let captured: unknown;
      try {
        await tenants.create(
          db,
          { externalId: 'INVALID UPPER', displayName: 'X', tier: 'STANDARD' },
          { actor: ACTOR },
        );
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantValidationError);
      expect((captured as TenantValidationError).cause).toBeInstanceOf(ZodError);
    });

    it('atomicity: forced throw on second emitAuditEvent rolls back tenant + config rows', async () => {
      const externalId = externalIdFor('create-atomic-rollback');
      // First call (TENANT_CREATED): no-op success — skip the actual audit
      // write so we can isolate the rollback behavior of the surrounding
      // tenant + config inserts. Second call (TENANT_CONFIG_VERSION_CREATED):
      // throw to trigger the txn rollback.
      emitAuditEventSpy.mockImplementationOnce(() => Promise.resolve());
      emitAuditEventSpy.mockImplementationOnce(() =>
        Promise.reject(new Error('forced rollback for atomicity test')),
      );

      let captured: unknown;
      try {
        await tenants.create(
          db,
          {
            externalId,
            displayName: 'Atomic Rollback',
            tier: 'STANDARD',
            initialConfig: { rolled: 'back' },
          },
          { actor: ACTOR },
        );
      } catch (err) {
        captured = err;
      }
      expect((captured as Error).message).toBe('forced rollback for atomicity test');

      // Tenant table has no RLS — direct count works.
      const tenantCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tenant WHERE external_id = $1`,
        [externalId],
      );
      expect(tenantCount.rows[0]?.count).toBe('0');

      // tenant_config_version FK is REFERENCES tenant(id) ON DELETE
      // RESTRICT — a config row cannot exist without a matching tenant
      // row. Since the tenant rolled back to count=0, any config row
      // inserted in the same txn also rolled back (FK + atomicity). No
      // separate bound query needed (and we don't know the rolled-back
      // tenant_id to bind to anyway).
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // get + getByExternalId
  // ───────────────────────────────────────────────────────────────────

  describe('get / getByExternalId', () => {
    it('get: happy path returns the tenant', async () => {
      const externalId = externalIdFor('get-happy');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'Get Happy', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      const fetched = await tenants.get(db, created.id);
      expect(fetched).toMatchObject({
        id: created.id,
        external_id: externalId,
        display_name: 'Get Happy',
      });
    });

    it('get: non-existent ID throws TenantNotFoundError(kind=id)', async () => {
      const ghostId = randomUUID();
      let captured: unknown;
      try {
        await tenants.get(db, ghostId);
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantNotFoundError);
      expect((captured as TenantNotFoundError).kind).toBe('id');
      expect((captured as TenantNotFoundError).identifier).toBe(ghostId);
    });

    it('get: invalid UUID throws TenantValidationError', async () => {
      await expect(tenants.get(db, 'not-a-uuid')).rejects.toBeInstanceOf(TenantValidationError);
    });

    it('getByExternalId: happy path returns tenant; non-existent throws kind=external_id', async () => {
      const externalId = externalIdFor('get-by-ext');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'Ext Lookup', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      const fetched = await tenants.getByExternalId(db, externalId);
      expect(fetched.id).toBe(created.id);

      let captured: unknown;
      try {
        await tenants.getByExternalId(db, externalIdFor('get-by-ext-nonexistent'));
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantNotFoundError);
      expect((captured as TenantNotFoundError).kind).toBe('external_id');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // list
  // ───────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns paginated result; our created tenants are present in the items', async () => {
      const baseExt = externalIdFor('list-base');
      const a = await tenants.create(
        db,
        { externalId: `${baseExt}-a`, displayName: 'List A', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(a.id);
      await sleep(2);
      const b = await tenants.create(
        db,
        { externalId: `${baseExt}-b`, displayName: 'List B', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(b.id);

      const result = await tenants.list(db, { limit: 200 });
      expect(result.limit).toBe(200);
      expect(result.offset).toBe(0);
      expect(result.total).toBeGreaterThanOrEqual(2);

      const ids = result.items.map((t) => t.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it('limit/offset honored; defaults limit=50; rejects out-of-range with TenantValidationError', async () => {
      const result = await tenants.list(db);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);

      await expect(tenants.list(db, { limit: 0 })).rejects.toBeInstanceOf(TenantValidationError);
      await expect(tenants.list(db, { limit: 201 })).rejects.toBeInstanceOf(TenantValidationError);
      await expect(tenants.list(db, { offset: -1 })).rejects.toBeInstanceOf(TenantValidationError);
    });

    it('items ordered by created_at ascending', async () => {
      // Use the IDs we created earlier in this describe block — they were
      // inserted with a 2ms gap so their created_at differ.
      const result = await tenants.list(db, { limit: 200 });
      const ours = result.items.filter((t) => t.external_id.startsWith(`test-tenants-${RUN_TAG}-`));
      const timestamps = ours.map((t) => new Date(t.created_at).getTime());
      const sorted = [...timestamps].sort((x, y) => x - y);
      expect(timestamps).toEqual(sorted);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // update
  // ───────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('happy path updates displayName; emits TENANT_UPDATED with before+changes', async () => {
      const externalId = externalIdFor('update-happy');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'Original Name', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      const updated = await tenants.update(
        db,
        created.id,
        { displayName: 'New Name' },
        { actor: ACTOR },
      );
      expect(updated.display_name).toBe('New Name');
      expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updated_at).getTime(),
      );

      const events = await fetchAuditEvents(db, created.id);
      const updateEvent = events.find((e) => e.action === 'TENANT_UPDATED');
      expect(updateEvent).toBeDefined();
      expect(updateEvent?.payload).toMatchObject({
        changes: { displayName: 'New Name' },
        before: { displayName: 'Original Name' },
      });
    });

    it('empty patch fails zod refine with TenantValidationError', async () => {
      const externalId = externalIdFor('update-empty-patch');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'X', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      await expect(tenants.update(db, created.id, {}, { actor: ACTOR })).rejects.toBeInstanceOf(
        TenantValidationError,
      );
    });

    it('TERMINATED tenant rejects update with TenantStatusError', async () => {
      const externalId = externalIdFor('update-on-terminated');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'Will Terminate', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      await tenants.setStatus(db, created.id, 'ACTIVE', { actor: ACTOR });
      await tenants.setStatus(db, created.id, 'TERMINATED', { actor: ACTOR });

      let captured: unknown;
      try {
        await tenants.update(db, created.id, { displayName: 'Resurrected' }, { actor: ACTOR });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantStatusError);
      expect((captured as TenantStatusError).currentStatus).toBe('TERMINATED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // setStatus
  // ───────────────────────────────────────────────────────────────────

  describe('setStatus', () => {
    it('happy path PROVISIONING → ACTIVE; emits TENANT_STATUS_CHANGED with from/to', async () => {
      const externalId = externalIdFor('setstatus-happy');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'Status Happy', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);

      const updated = await tenants.setStatus(db, created.id, 'ACTIVE', {
        actor: ACTOR,
      });
      expect(updated.status).toBe('ACTIVE');

      const events = await fetchAuditEvents(db, created.id);
      const statusEvent = events.find((e) => e.action === 'TENANT_STATUS_CHANGED');
      expect(statusEvent?.payload).toMatchObject({
        from: 'PROVISIONING',
        to: 'ACTIVE',
      });
    });

    it('ACTIVE → ACTIVE rejected with TenantStatusError (no idempotent no-op)', async () => {
      const externalId = externalIdFor('setstatus-noop');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'No Noop', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);
      await tenants.setStatus(db, created.id, 'ACTIVE', { actor: ACTOR });

      let captured: unknown;
      try {
        await tenants.setStatus(db, created.id, 'ACTIVE', { actor: ACTOR });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantStatusError);
      expect((captured as TenantStatusError).currentStatus).toBe('ACTIVE');
    });

    it('TERMINATED → ACTIVE rejected with TenantStatusError', async () => {
      const externalId = externalIdFor('setstatus-from-terminated');
      const created = await tenants.create(
        db,
        { externalId, displayName: 'Tombstone', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(created.id);
      await tenants.setStatus(db, created.id, 'ACTIVE', { actor: ACTOR });
      await tenants.setStatus(db, created.id, 'TERMINATED', { actor: ACTOR });

      let captured: unknown;
      try {
        await tenants.setStatus(db, created.id, 'ACTIVE', { actor: ACTOR });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantStatusError);
      expect((captured as TenantStatusError).currentStatus).toBe('TERMINATED');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

type AuditEventRow = {
  action: string;
  occurred_at: string;
  payload: Record<string, unknown>;
} & Record<string, unknown>;

async function fetchAuditEvents(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<AuditEventRow[]> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    // occurred_at defaults to transaction_timestamp() which is CONSTANT
    // within a single transaction — two audit emits inside the same
    // db.transaction(...) (e.g., TENANT_CREATED + TENANT_CONFIG_VERSION_CREATED
    // from tenants.create) receive identical occurred_at, so sorting by
    // it alone is ambiguous. ctid is Postgres's physical row identifier,
    // monotonic for sequential INSERTs on the same backend within a txn,
    // used here as a reliable tiebreaker. The hash chain
    // (prev_hash → curr_hash) encodes canonical event order in
    // production; this ordering is purely for test row-recovery.
    const result = await tx.execute<AuditEventRow>(
      sql`SELECT action, occurred_at, payload FROM audit_event
            WHERE tenant_id = ${tenantId}
            ORDER BY occurred_at ASC, ctid ASC`,
    );
    return result.rows;
  });
}

/**
 * Tests for `tenants.suspend` + `tenants.resume` (F02 Slice B).
 *
 * Verifies SB1 (asymmetric audit emission — TENANT_SUSPENDED for
 * suspend, TENANT_STATUS_CHANGED for resume), SB5 Option α (idempotent
 * re-call is no-op, no audit emission), Q-NEW-1 (`reason` validated
 * 1–500 chars, captured in payload.reason), Q-NEW-2 (resume takes no
 * reason). Pessimistic `.for('update')` row lock is exercised
 * structurally; the §10.15 contention test ships in sub-phase 3.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenant } from '@cortex/canonical-schema';
import { tenants } from '../src/tenants.js';
import { TenantNotFoundError, TenantStatusError, TenantValidationError } from '../src/errors.js';
import { fetchAuditEvents } from './helpers/audit.js';
import {
  deferred,
  forceRlsOnAuditEvent,
  getPool,
  withBoundClient,
  withTwoBoundClients,
} from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = { type: 'service' as const, id: 'suspend-resume-spec', description: 'SR test' };

describe('tenants.suspend + tenants.resume', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    pool = getPool();
    db = drizzle(pool);
    await forceRlsOnAuditEvent(pool);
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      try {
        await withBoundClient(pool, id, async (client) => {
          await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [id]);
          await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
        });
      } catch {
        // tenant may not exist; ignore
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function externalIdFor(label: string): string {
    return `test-suspend-resume-${RUN_TAG}-${label}`;
  }

  /** Create a tenant directly at ACTIVE so suspend's happy path is exercisable. */
  async function createActive(label: string): Promise<string> {
    const created = await tenants.create(
      db,
      {
        externalId: externalIdFor(label),
        displayName: `SR ${label}`,
        tier: 'STANDARD',
        initialStatus: 'ACTIVE',
      },
      { actor: ACTOR },
    );
    createdTenantIds.push(created.id);
    return created.id;
  }

  // ───────────────────────────────────────────────────────────────────
  // suspend — happy path + audit asymmetry
  // ───────────────────────────────────────────────────────────────────

  describe('suspend — happy path', () => {
    it('flips ACTIVE → SUSPENDED and emits TENANT_SUSPENDED with reason in payload', async () => {
      const id = await createActive('happy-1');
      const reason = 'manual ops review per ticket SEC-1234';

      const after = await tenants.suspend(db, id, reason, { actor: ACTOR });

      expect(after.status).toBe('SUSPENDED');

      const events = await fetchAuditEvents(db, id);
      const suspendEvent = events.find((e) => e.action === 'TENANT_SUSPENDED');
      expect(suspendEvent).toBeDefined();
      expect(suspendEvent?.payload).toMatchObject({
        before_state: { status: 'ACTIVE' },
        after_state: { status: 'SUSPENDED' },
        reason,
      });
    });

    it('TENANT_SUSPENDED audit row carries the caller-supplied actor', async () => {
      const id = await createActive('actor-1');
      await tenants.suspend(db, id, 'attribution check', { actor: ACTOR });

      const events = await fetchAuditEvents(db, id);
      const suspendEvent = events.find((e) => e.action === 'TENANT_SUSPENDED');
      expect(suspendEvent?.actor_type).toBe(ACTOR.type);
      expect(suspendEvent?.actor_id).toBe(ACTOR.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // suspend — SB5 Option α idempotency
  // ───────────────────────────────────────────────────────────────────

  describe('suspend — idempotency (SB5 Option α)', () => {
    it('re-suspending a SUSPENDED tenant is no-op: status unchanged, no new audit row', async () => {
      const id = await createActive('idempotent-1');
      await tenants.suspend(db, id, 'first suspend', { actor: ACTOR });

      const before = await fetchAuditEvents(db, id);
      const beforeCount = before.length;

      const after = await tenants.suspend(db, id, 'second suspend (no-op)', { actor: ACTOR });
      expect(after.status).toBe('SUSPENDED');

      const afterEvents = await fetchAuditEvents(db, id);
      expect(afterEvents.length).toBe(beforeCount);
      // Only the first suspend's reason persists; the no-op never touched payload.
      const suspendEvents = afterEvents.filter((e) => e.action === 'TENANT_SUSPENDED');
      expect(suspendEvents).toHaveLength(1);
      expect(suspendEvents[0]?.payload).toMatchObject({ reason: 'first suspend' });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // suspend — reason validation (Q-NEW-1)
  // ───────────────────────────────────────────────────────────────────

  describe('suspend — reason validation (Q-NEW-1)', () => {
    it('empty-string reason is rejected with TenantValidationError', async () => {
      const id = await createActive('reason-empty');
      await expect(tenants.suspend(db, id, '', { actor: ACTOR })).rejects.toBeInstanceOf(
        TenantValidationError,
      );
    });

    it('501-char reason is rejected with TenantValidationError', async () => {
      const id = await createActive('reason-too-long');
      const tooLong = 'x'.repeat(501);
      await expect(tenants.suspend(db, id, tooLong, { actor: ACTOR })).rejects.toBeInstanceOf(
        TenantValidationError,
      );
    });

    it('500-char reason is accepted (boundary)', async () => {
      const id = await createActive('reason-boundary');
      const exact = 'x'.repeat(500);
      const after = await tenants.suspend(db, id, exact, { actor: ACTOR });
      expect(after.status).toBe('SUSPENDED');

      const events = await fetchAuditEvents(db, id);
      const suspendEvent = events.find((e) => e.action === 'TENANT_SUSPENDED');
      expect(suspendEvent?.payload).toMatchObject({ reason: exact });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // suspend — invalid transitions
  // ───────────────────────────────────────────────────────────────────

  describe('suspend — invalid transitions', () => {
    it('REQUESTED tenant suspend rejects with TenantStatusError', async () => {
      const created = await tenants.create(
        db,
        {
          externalId: externalIdFor('from-requested'),
          displayName: 'Req',
          tier: 'ENTERPRISE',
          initialStatus: 'REQUESTED',
        },
        { actor: ACTOR },
      );
      createdTenantIds.push(created.id);

      let captured: unknown;
      try {
        await tenants.suspend(db, created.id, 'invalid origin', { actor: ACTOR });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantStatusError);
      expect((captured as TenantStatusError).currentStatus).toBe('REQUESTED');
    });

    it('TERMINATED tenant suspend rejects with TenantStatusError', async () => {
      const id = await createActive('from-terminated');
      await tenants.setStatus(db, id, 'TERMINATED', { actor: ACTOR });

      let captured: unknown;
      try {
        await tenants.suspend(db, id, 'too late', { actor: ACTOR });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantStatusError);
      expect((captured as TenantStatusError).currentStatus).toBe('TERMINATED');
    });

    it('non-existent tenant suspend throws TenantNotFoundError', async () => {
      const ghostId = randomUUID();
      await expect(
        tenants.suspend(db, ghostId, 'no such tenant', { actor: ACTOR }),
      ).rejects.toBeInstanceOf(TenantNotFoundError);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // resume — happy path
  // ───────────────────────────────────────────────────────────────────

  describe('resume — happy path', () => {
    it('flips SUSPENDED → ACTIVE and emits TENANT_STATUS_CHANGED (NOT TENANT_SUSPENDED)', async () => {
      const id = await createActive('resume-1');
      await tenants.suspend(db, id, 'temporary', { actor: ACTOR });

      const after = await tenants.resume(db, id, { actor: ACTOR });
      expect(after.status).toBe('ACTIVE');

      const events = await fetchAuditEvents(db, id);
      // Resume emits TENANT_STATUS_CHANGED, not a domain TENANT_RESUMED.
      const resumeEvent = events
        .filter((e) => e.action === 'TENANT_STATUS_CHANGED')
        .find(
          (e) =>
            (e.payload as { before_state?: { status?: string } }).before_state?.status ===
            'SUSPENDED',
        );
      expect(resumeEvent).toBeDefined();
      expect(resumeEvent?.payload).toMatchObject({
        before_state: { status: 'SUSPENDED' },
        after_state: { status: 'ACTIVE' },
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // resume — SB5 Option α idempotency
  // ───────────────────────────────────────────────────────────────────

  describe('resume — idempotency (SB5 Option α)', () => {
    it('resuming an already-ACTIVE tenant is no-op: status unchanged, no new audit row', async () => {
      const id = await createActive('resume-idempotent');

      const before = await fetchAuditEvents(db, id);
      const beforeCount = before.length;

      const after = await tenants.resume(db, id, { actor: ACTOR });
      expect(after.status).toBe('ACTIVE');

      const afterEvents = await fetchAuditEvents(db, id);
      expect(afterEvents.length).toBe(beforeCount);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // resume — invalid transitions
  // ───────────────────────────────────────────────────────────────────

  describe('resume — invalid transitions', () => {
    it('REQUESTED tenant resume rejects with TenantStatusError', async () => {
      const created = await tenants.create(
        db,
        {
          externalId: externalIdFor('resume-from-requested'),
          displayName: 'Req',
          tier: 'ENTERPRISE',
          initialStatus: 'REQUESTED',
        },
        { actor: ACTOR },
      );
      createdTenantIds.push(created.id);

      let captured: unknown;
      try {
        await tenants.resume(db, created.id, { actor: ACTOR });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantStatusError);
      expect((captured as TenantStatusError).currentStatus).toBe('REQUESTED');
    });

    it('TERMINATED tenant resume rejects with TenantStatusError', async () => {
      const id = await createActive('resume-from-terminated');
      await tenants.setStatus(db, id, 'TERMINATED', { actor: ACTOR });

      let captured: unknown;
      try {
        await tenants.resume(db, id, { actor: ACTOR });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantStatusError);
      expect((captured as TenantStatusError).currentStatus).toBe('TERMINATED');
    });

    it('non-existent tenant resume throws TenantNotFoundError', async () => {
      const ghostId = randomUUID();
      await expect(tenants.resume(db, ghostId, { actor: ACTOR })).rejects.toBeInstanceOf(
        TenantNotFoundError,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Audit asymmetry — suspend → resume → suspend cycle (SB1 verify)
  // ───────────────────────────────────────────────────────────────────

  describe('audit asymmetry (SB1)', () => {
    it('suspend → resume → suspend cycle yields TENANT_SUSPENDED ×2 + TENANT_STATUS_CHANGED ×1, NOT three STATUS_CHANGED rows', async () => {
      const id = await createActive('asymmetry-1');

      await tenants.suspend(db, id, 'first', { actor: ACTOR });
      await tenants.resume(db, id, { actor: ACTOR });
      await tenants.suspend(db, id, 'second', { actor: ACTOR });

      const events = await fetchAuditEvents(db, id);
      const suspendEvents = events.filter((e) => e.action === 'TENANT_SUSPENDED');
      const statusChangedFromSuspended = events
        .filter((e) => e.action === 'TENANT_STATUS_CHANGED')
        .filter(
          (e) =>
            (e.payload as { before_state?: { status?: string } }).before_state?.status ===
            'SUSPENDED',
        );

      expect(suspendEvents).toHaveLength(2);
      expect(statusChangedFromSuspended).toHaveLength(1);
      // Reasons preserved across the cycle.
      expect(suspendEvents.map((e) => (e.payload as { reason?: string }).reason)).toEqual([
        'first',
        'second',
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // §10.15 — Contention behavior under concurrent state changes
  //
  // Per future-roadmap §10.15: `setStatus` / `update` / `suspend` /
  // `resume` use `.for('update')` row locks. The lock semantics are
  // correct by Postgres language spec, but a regression in our query
  // construction (e.g., a refactor silently dropping `.for('update')`)
  // could leave concurrent operators racing. These tests exercise the
  // actual lock under contention from two independent connections.
  // ───────────────────────────────────────────────────────────────────

  describe('§10.15 — Contention under concurrent state changes', () => {
    it('SELECT FOR UPDATE blocks tx2 until tx1 commits; tx2 reads the post-commit state', async () => {
      // Setup: ACTIVE tenant, plus a barrier so tx2 only attempts the
      // contended SELECT after tx1 already holds the lock.
      const id = await createActive('contention-lock');
      const tx1HasLock = deferred<void>();
      let tx1CommittedAt = 0;
      let tx2SelectReturnedAt = 0;

      const [result1, result2] = await withTwoBoundClients(
        pool,
        id,
        // tx1: grabs the lock first, holds briefly to give tx2 time to
        // arrive at its blocking SELECT, then UPDATEs and commits.
        async (tx1) => {
          const before = await tx1
            .select()
            .from(tenant)
            .where(eq(tenant.id, id))
            .for('update')
            .limit(1);
          tx1HasLock.resolve();
          // Hold the lock for ~80ms to ensure tx2's SELECT request has
          // arrived at Postgres and is parked on the lock manager.
          await sleep(80);
          await tx1
            .update(tenant)
            .set({
              status: 'SUSPENDED',
              updated_at: sql`date_trunc('millisecond', now())`,
            })
            .where(eq(tenant.id, id));
          tx1CommittedAt = Date.now();
          return before[0]?.status ?? 'UNKNOWN';
        },
        // tx2: waits for the barrier, then issues SELECT FOR UPDATE.
        // This blocks at the DB layer until tx1's transaction commits.
        async (tx2) => {
          await tx1HasLock.promise;
          const after = await tx2
            .select()
            .from(tenant)
            .where(eq(tenant.id, id))
            .for('update')
            .limit(1);
          tx2SelectReturnedAt = Date.now();
          return after[0]?.status ?? 'UNKNOWN';
        },
      );

      // tx1 saw the pre-update state (still ACTIVE inside its txn).
      expect(result1).toBe('ACTIVE');
      // tx2 saw the post-update state — could only happen if its
      // SELECT FOR UPDATE serialized AFTER tx1's commit.
      expect(result2).toBe('SUSPENDED');
      // Sanity: tx2's SELECT returned at-or-after tx1's commit moment.
      // If the lock had been silently dropped, tx2 would have returned
      // immediately during tx1's 80ms hold.
      expect(tx2SelectReturnedAt).toBeGreaterThanOrEqual(tx1CommittedAt);
    });

    it('two concurrent tenants.suspend() calls produce exactly ONE TENANT_SUSPENDED audit row (lock + SB5 idempotency)', async () => {
      // Verifies the production code path under real contention: the
      // first call's row lock blocks the second's SELECT FOR UPDATE;
      // the second call reads the now-SUSPENDED state and per SB5
      // Option α returns no-op (no audit emission). If the lock had a
      // regression, both calls would observe ACTIVE and emit two rows.
      const id = await createActive('contention-suspend');

      const [r1, r2] = await Promise.all([
        tenants.suspend(db, id, 'concurrent A', { actor: ACTOR }),
        tenants.suspend(db, id, 'concurrent B', { actor: ACTOR }),
      ]);

      // Both calls return the SUSPENDED row (winner via UPDATE; loser
      // via SB5 no-op).
      expect(r1.status).toBe('SUSPENDED');
      expect(r2.status).toBe('SUSPENDED');

      const events = await fetchAuditEvents(db, id);
      const suspendEvents = events.filter((e) => e.action === 'TENANT_SUSPENDED');
      expect(suspendEvents).toHaveLength(1);
      // The winner's reason persists; the loser's reason was discarded
      // when SB5 short-circuited before audit emit.
      const winningReason = (suspendEvents[0]?.payload as { reason?: string }).reason;
      expect(['concurrent A', 'concurrent B']).toContain(winningReason);
    });

    it('tenants.suspend executes a SELECT ... FOR UPDATE (regression guard via Drizzle query log)', async () => {
      // Catches the §10.15-flagged regression mode: a refactor silently
      // drops `.for('update')` from the query construction. Spies on
      // the production code path by attaching a Drizzle logger that
      // captures every SQL statement issued during a real
      // `tenants.suspend()` call.
      const id = await createActive('regression-guard');
      const captured: string[] = [];
      const loggingDb = drizzle(pool, {
        logger: {
          logQuery: (q) => {
            captured.push(q);
          },
        },
      });

      await tenants.suspend(loggingDb, id, 'regression guard', { actor: ACTOR });

      const lockingSelect = captured.find(
        (q) => /select/i.test(q) && /from\s+"?tenant"?/i.test(q) && /for\s+update/i.test(q),
      );
      expect(lockingSelect).toBeDefined();
    });
  });
});

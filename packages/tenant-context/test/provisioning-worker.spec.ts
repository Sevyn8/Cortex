/**
 * Tests for `provisioningWorker` — the async-workflow half of F02 Slice
 * A's provisioning. Worker is invoked directly (per planning-doc SA4
 * "worker-direct unit tests"); Cloud Tasks dispatch is mocked only for
 * the setup phase (tenants.provision still runs to populate substrate).
 *
 * State machine coverage:
 *   - Pre-check idempotency (SA11): no-op on already-past-PROVISIONING.
 *   - REQUESTED + Enterprise + !approved → no-op (SA13).
 *   - REQUESTED + Enterprise + approved → ACTIVE.
 *   - PROVISIONING (Standard) → READY → ACTIVE with smoke-test pass.
 *   - PROVISIONING with missing substrate → throws + cleanup (SA10/SA14).
 *   - Audit chain: TENANT_STATUS_CHANGED × 2 + TENANT_PROVISIONED.
 *   - Rollback semantics: cleanupFailedProvisioning idempotency + safety
 *     guard (refuses tenants past PROVISIONING).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { tenants } from '../src/tenants.js';
import {
  cleanupFailedProvisioning,
  provisioningWorker,
  type ProvisioningTaskPayload,
} from '../src/provisioning-worker.js';
import { __setClientForTesting } from '../src/cloud-tasks.js';
import { TenantNotFoundError } from '../src/errors.js';
import { fetchAuditEvents } from './helpers/audit.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const CALLER_ACTOR = {
  type: 'service' as const,
  id: 'provision-worker-spec',
  description: 'worker test caller',
};

interface MockClient {
  createTask: ReturnType<typeof vi.fn>;
  queuePath: ReturnType<typeof vi.fn>;
  taskPath: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockClient {
  return {
    createTask: vi.fn().mockResolvedValue([{ name: 'projects/x/tasks/y' }]),
    queuePath: vi.fn().mockReturnValue('projects/x/locations/y/queues/z'),
    taskPath: vi.fn().mockReturnValue('projects/x/locations/y/queues/z/tasks/t'),
  };
}

/** Build a worker payload from a tenantId + the file's caller actor. */
function workerPayload(tenantId: string): ProvisioningTaskPayload {
  return {
    tenantId,
    actorType: CALLER_ACTOR.type,
    actorId: CALLER_ACTOR.id,
    actorDescription: CALLER_ACTOR.description,
  };
}

describe('provisioningWorker', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    pool = getPool();
    db = drizzle(pool);
  });

  beforeEach(async () => {
    process.env.PROVISIONING_WORKER_URL = 'https://provisioning-worker.example.com';
    __setClientForTesting(createMockClient() as unknown as CloudTasksClient);
    await forceRlsOnAuditEvent(pool);
  });

  afterEach(() => {
    __setClientForTesting(null);
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      try {
        await withBoundClient(pool, id, async (client) => {
          await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [id]);
          await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
        });
      } catch {
        // ignore
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function trackTenant(id: string) {
    createdTenantIds.push(id);
  }

  function externalIdFor(label: string): string {
    return `test-worker-${RUN_TAG}-${label}`;
  }

  // ───────────────────────────────────────────────────────────────────
  // Idempotency pre-check (SA11)
  // ───────────────────────────────────────────────────────────────────

  describe('idempotency pre-check (SA11)', () => {
    it('no-ops when tenant does not exist (post-cleanup or stale taskId)', async () => {
      const ghostId = randomUUID();
      // Should not throw; tenant doesn't exist → treat as success.
      await expect(provisioningWorker(db, workerPayload(ghostId))).resolves.toBeUndefined();
    });

    it('no-ops when tenant is already at ACTIVE', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('already-active'), displayName: 'AA', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      // Drive to ACTIVE via a first worker run.
      await provisioningWorker(db, workerPayload(result.tenantId));
      const beforeRefire = await tenants.get(db, result.tenantId);
      expect(beforeRefire.status).toBe('ACTIVE');

      // Re-fire: should be a no-op.
      const auditCountBefore = (await fetchAuditEvents(db, result.tenantId)).length;
      await provisioningWorker(db, workerPayload(result.tenantId));
      const afterRefire = await tenants.get(db, result.tenantId);
      const auditCountAfter = (await fetchAuditEvents(db, result.tenantId)).length;

      expect(afterRefire.status).toBe('ACTIVE');
      expect(auditCountAfter).toBe(auditCountBefore); // no new audit rows
    });

    it('no-ops when tenant is at SUSPENDED (worker is not the suspend handler)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('already-susp'), displayName: 'AS', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);
      await provisioningWorker(db, workerPayload(result.tenantId));
      // Move ACTIVE → SUSPENDED out-of-band.
      await tenants.setStatus(db, result.tenantId, 'SUSPENDED', { actor: CALLER_ACTOR });

      // Re-fire worker: should not advance.
      await provisioningWorker(db, workerPayload(result.tenantId));
      const final = await tenants.get(db, result.tenantId);
      expect(final.status).toBe('SUSPENDED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Standard tenant flow
  // ───────────────────────────────────────────────────────────────────

  describe('Standard tenant flow (PROVISIONING → READY → ACTIVE)', () => {
    it('advances PROVISIONING → READY → ACTIVE with substrate verified', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('std-flow'), displayName: 'SF', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);
      expect(result.status).toBe('PROVISIONING');

      await provisioningWorker(db, workerPayload(result.tenantId));

      const final = await tenants.get(db, result.tenantId);
      expect(final.status).toBe('ACTIVE');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Enterprise approval gate (SA13)
  // ───────────────────────────────────────────────────────────────────

  describe('Enterprise approval gate (SA13)', () => {
    it('REQUESTED + dedicated_db_approved=false → no-op (worker awaits operator)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('ent-await'), displayName: 'EA', tier: 'ENTERPRISE' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);
      expect(result.status).toBe('REQUESTED');

      await provisioningWorker(db, workerPayload(result.tenantId));

      const stillRequested = await tenants.get(db, result.tenantId);
      expect(stillRequested.status).toBe('REQUESTED');
      expect(stillRequested.dedicated_db_approved).toBe(false);
    });

    it('REQUESTED + dedicated_db_approved=true → advances to ACTIVE', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('ent-approved'), displayName: 'EAA', tier: 'ENTERPRISE' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      // Operator approves dedicated DB allocation (Slice D HTTP endpoint
      // simulated via direct UPDATE). tenant table has no RLS — direct
      // UPDATE works without binding.
      await pool.query('UPDATE tenant SET dedicated_db_approved = true WHERE id = $1', [
        result.tenantId,
      ]);

      // Slice D's approval endpoint would re-enqueue; we simulate by
      // calling the worker directly (per SA13 / SA4).
      await provisioningWorker(db, workerPayload(result.tenantId));

      const final = await tenants.get(db, result.tenantId);
      expect(final.status).toBe('ACTIVE');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Smoke test (SA8)
  // ───────────────────────────────────────────────────────────────────

  describe('smoke test (SA8 substrate verification)', () => {
    it('passes when tenant_kms_key row exists', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('smoke-ok'), displayName: 'SO', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      // Worker ran successfully; final status proves smoke test passed.
      await provisioningWorker(db, workerPayload(result.tenantId));
      const final = await tenants.get(db, result.tenantId);
      expect(final.status).toBe('ACTIVE');
    });

    // The smoke-test failure path is exercised via the rollback describe
    // block below; the worker's smoke-test failure now triggers
    // cleanupFailedProvisioning per SA14, so the tenant row is deleted
    // (not stuck at PROVISIONING). See "Rollback semantics" tests.
  });

  // ───────────────────────────────────────────────────────────────────
  // Audit emission chain
  // ───────────────────────────────────────────────────────────────────

  describe('audit emission chain', () => {
    it('emits TENANT_PROVISIONED with after_state.status=READY and caller actor', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('audit-prov'), displayName: 'AP', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      await provisioningWorker(db, workerPayload(result.tenantId));

      const events = await fetchAuditEvents(db, result.tenantId);
      const provisioned = events.find((e) => e.action === 'TENANT_PROVISIONED');
      expect(provisioned).toBeDefined();
      expect(provisioned?.payload).toMatchObject({
        after_state: { status: 'READY' },
      });
      // Caller actor preserved for forensic attribution (per planning-doc D6).
      expect(provisioned?.actor_id).toBe(CALLER_ACTOR.id);
      expect(provisioned?.actor_type).toBe(CALLER_ACTOR.type);
    });

    it('emits two TENANT_STATUS_CHANGED events with cortex-tenant-lifecycle service actor', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('audit-status'), displayName: 'ASt', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      await provisioningWorker(db, workerPayload(result.tenantId));

      const events = await fetchAuditEvents(db, result.tenantId);
      const statusChanges = events.filter((e) => e.action === 'TENANT_STATUS_CHANGED');
      // Standard flow: PROVISIONING → READY (1) and READY → ACTIVE (2).
      expect(statusChanges).toHaveLength(2);
      for (const e of statusChanges) {
        expect(e.actor_type).toBe('service');
        expect(e.actor_id).toBe('cortex-tenant-lifecycle');
      }
    });

    it('full audit chain ordering: CREATED, KMS_KEY_BOUND, STATUS_CHANGED(P→R), PROVISIONED, STATUS_CHANGED(R→A)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('audit-order'), displayName: 'AO', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      await provisioningWorker(db, workerPayload(result.tenantId));

      const events = await fetchAuditEvents(db, result.tenantId);
      const actions = events.map((e) => e.action);
      // No initialConfig → no TENANT_CONFIG_VERSION_CREATED.
      expect(actions).toEqual([
        'TENANT_CREATED',
        'TENANT_KMS_KEY_BOUND',
        'TENANT_STATUS_CHANGED', // PROVISIONING → READY
        'TENANT_PROVISIONED',
        'TENANT_STATUS_CHANGED', // READY → ACTIVE
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Idempotency under retry (re-fire is safe)
  // ───────────────────────────────────────────────────────────────────

  describe('retry safety (SA11 + Cloud Tasks dedup defense-in-depth)', () => {
    it('re-firing a successful worker is a no-op (no audit duplication)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('retry-safe'), displayName: 'RS', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      await provisioningWorker(db, workerPayload(result.tenantId));
      const eventsAfterFirst = await fetchAuditEvents(db, result.tenantId);

      // Cloud Tasks dedup window may let a duplicate slip; SA11 worker
      // pre-check makes that safe. Re-fire and confirm no new events.
      await provisioningWorker(db, workerPayload(result.tenantId));
      const eventsAfterSecond = await fetchAuditEvents(db, result.tenantId);

      expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Rollback semantics (SA10 + SA14): cleanupFailedProvisioning
  // ───────────────────────────────────────────────────────────────────

  /** Sabotage helper — delete tenant_kms_key out-of-band to force smoke-test failure. */
  async function sabotageKmsKey(tenantId: string): Promise<void> {
    await withBoundClient(pool, tenantId, async (client) => {
      await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [tenantId]);
    });
  }

  describe('Rollback semantics (cleanupFailedProvisioning)', () => {
    it('smoke-test failure triggers cleanup; tenant row removed; "cleaned up" message', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('rollback-smoke'), displayName: 'RS', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      await sabotageKmsKey(result.tenantId);

      await expect(provisioningWorker(db, workerPayload(result.tenantId))).rejects.toThrow(
        /smoke test failed.*cleaned up/i,
      );

      // Cleanup ran: tenant row deleted; tenants.get throws TenantNotFoundError.
      await expect(tenants.get(db, result.tenantId)).rejects.toThrow(TenantNotFoundError);
    });

    it('after cleanup, operator can resubmit with same external_id (slot freed)', async () => {
      const externalId = externalIdFor('rollback-resubmit');
      const first = await tenants.provision(
        db,
        { externalId, displayName: 'RR', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(first.tenantId);

      await sabotageKmsKey(first.tenantId);
      await expect(provisioningWorker(db, workerPayload(first.tenantId))).rejects.toThrow();

      // First tenant gone; resubmit with same external_id should succeed.
      const second = await tenants.provision(
        db,
        { externalId, displayName: 'RR (retry)', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(second.tenantId);

      expect(second.tenantId).not.toBe(first.tenantId);
      const secondTenant = await tenants.get(db, second.tenantId);
      expect(secondTenant.external_id).toBe(externalId);
      expect(secondTenant.status).toBe('PROVISIONING');
    });

    it('cleanupFailedProvisioning is idempotent (re-call after success is no-op)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('rollback-idem'), displayName: 'RI', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      // First call: cleanup happens.
      await cleanupFailedProvisioning(db, result.tenantId);
      await expect(tenants.get(db, result.tenantId)).rejects.toThrow(TenantNotFoundError);

      // Second call: idempotent no-op (no throw).
      await expect(cleanupFailedProvisioning(db, result.tenantId)).resolves.toBeUndefined();
    });

    it('cleanupFailedProvisioning refuses to clean up tenants past PROVISIONING (safety guard)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('rollback-guard'), displayName: 'RG', tier: 'STANDARD' },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      // Drive worker to ACTIVE.
      await provisioningWorker(db, workerPayload(result.tenantId));
      const t = await tenants.get(db, result.tenantId);
      expect(t.status).toBe('ACTIVE');

      // Cleanup refuses with safety message pointing to tenants.terminate.
      await expect(cleanupFailedProvisioning(db, result.tenantId)).rejects.toThrow(
        /use tenants\.terminate/,
      );

      // Tenant still exists.
      const stillThere = await tenants.get(db, result.tenantId);
      expect(stillThere.status).toBe('ACTIVE');
    });

    it('cleanup deletes tenant_config_version rows when initialConfig was supplied', async () => {
      const result = await tenants.provision(
        db,
        {
          externalId: externalIdFor('rollback-cfg'),
          displayName: 'RC',
          tier: 'STANDARD',
          initialConfig: { foo: 'bar' },
        },
        { actor: CALLER_ACTOR },
      );
      trackTenant(result.tenantId);

      // Verify v=1 exists pre-cleanup. RLS bind required for the read.
      // withBoundClient's callback returns void, so use a closure-captured
      // variable to surface the count.
      let beforeCount = 0;
      await withBoundClient(pool, result.tenantId, async (client) => {
        const r = await client.query<{ c: string }>(
          'SELECT count(*) AS c FROM tenant_config_version WHERE tenant_id = $1',
          [result.tenantId],
        );
        beforeCount = Number(r.rows[0]?.c ?? 0);
      });
      expect(beforeCount).toBe(1);

      await sabotageKmsKey(result.tenantId);
      await expect(provisioningWorker(db, workerPayload(result.tenantId))).rejects.toThrow();

      // Tenant gone; tenant_config_version + tenant_kms_key gone.
      await expect(tenants.get(db, result.tenantId)).rejects.toThrow(TenantNotFoundError);

      // Post-cleanup, set_config('app.tenant_id', <deleted-id>, true) still
      // works (it just sets the session var; doesn't validate existence).
      // Reads return 0 rows because the child rows were deleted.
      let afterCfg = -1;
      await withBoundClient(pool, result.tenantId, async (client) => {
        const r = await client.query<{ c: string }>(
          'SELECT count(*) AS c FROM tenant_config_version WHERE tenant_id = $1',
          [result.tenantId],
        );
        afterCfg = Number(r.rows[0]?.c ?? 0);
      });
      expect(afterCfg).toBe(0);

      let afterKms = -1;
      await withBoundClient(pool, result.tenantId, async (client) => {
        const r = await client.query<{ c: string }>(
          'SELECT count(*) AS c FROM tenant_kms_key WHERE tenant_id = $1',
          [result.tenantId],
        );
        afterKms = Number(r.rows[0]?.c ?? 0);
      });
      expect(afterKms).toBe(0);
    });
  });
});

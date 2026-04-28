/**
 * Tests for `tenants.forceTerminate` (F02 Slice C — sub-phase 7.5).
 *
 * Verifies SC2 lock: distinct `TENANT_FORCE_TERMINATED` audit action,
 * skipped legal-hold + grace-period checks captured as override
 * forensics in `payload.override_metadata`, same 5-step cascade as
 * `tenants.terminate`, soft-retain tombstone semantics.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { tenant as tenantTable } from '@cortex/canonical-schema';
import { tenants } from '../src/tenants.js';
import { legalHolds } from '../src/legal-holds.js';
import { TenantNotFoundError, TenantStatusError, TenantValidationError } from '../src/errors.js';
import { fetchAuditEvents } from './helpers/audit.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = {
  type: 'service' as const,
  id: 'force-terminate-spec',
  description: 'force-terminate test',
};

interface StubBucket {
  deleteFiles: ReturnType<typeof vi.fn>;
}
interface StubStorage {
  bucket: ReturnType<typeof vi.fn>;
  __bucket: StubBucket;
}

function createStubStorage(): StubStorage {
  const bucket: StubBucket = { deleteFiles: vi.fn().mockResolvedValue(undefined) };
  return { bucket: vi.fn().mockReturnValue(bucket), __bucket: bucket };
}

describe('tenants.forceTerminate', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    process.env.CORTEX_ENV = 'dev';
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
          await client.query('DELETE FROM tenant_quota_usage WHERE tenant_id = $1', [id]);
          await client.query('DELETE FROM legal_hold WHERE tenant_id = $1', [id]);
        });
      } catch {
        // ignore
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function externalIdFor(label: string): string {
    return `test-force-${RUN_TAG}-${label}`;
  }

  async function createAtStatus(
    label: string,
    initialStatus: 'ACTIVE' | 'SUSPENDED' | 'PROVISIONING' | 'TERMINATED' | 'OFFBOARDING',
    opts: { gracePeriodMs?: number; legalHoldBoolean?: boolean } = {},
  ): Promise<string> {
    const created = await tenants.create(
      db,
      {
        externalId: externalIdFor(label),
        displayName: `FT ${label}`,
        tier: 'STANDARD',
        initialStatus: initialStatus === 'OFFBOARDING' ? 'ACTIVE' : initialStatus,
      },
      { actor: ACTOR },
    );
    createdTenantIds.push(created.id);
    if (initialStatus === 'OFFBOARDING') {
      const grace =
        opts.gracePeriodMs !== undefined
          ? new Date(Date.now() + opts.gracePeriodMs)
          : new Date(Date.now() - 60_000); // default: already elapsed
      await db
        .update(tenantTable)
        .set({ status: 'OFFBOARDING', offboarding_grace_until: grace })
        .where(eq(tenantTable.id, created.id));
    }
    if (opts.legalHoldBoolean === true) {
      await db.update(tenantTable).set({ legal_hold: true }).where(eq(tenantTable.id, created.id));
    }
    return created.id;
  }

  // ───────────────────────────────────────────────────────────────────
  // Happy paths — transition coverage
  // ───────────────────────────────────────────────────────────────────

  describe('happy paths — transition coverage', () => {
    it('ACTIVE → TERMINATED: skips OFFBOARDING entirely', async () => {
      const id = await createAtStatus('active', 'ACTIVE');
      const stub = createStubStorage();

      const result = await tenants.forceTerminate(
        db,
        id,
        'urgent compliance request',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );
      expect(result.status).toBe('TERMINATED');
      expect(result.terminated_at).not.toBeNull();
    });

    it('SUSPENDED → TERMINATED: from suspended state', async () => {
      const id = await createAtStatus('suspended', 'SUSPENDED');
      const stub = createStubStorage();

      const result = await tenants.forceTerminate(
        db,
        id,
        'security incident',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );
      expect(result.status).toBe('TERMINATED');
    });

    it('OFFBOARDING (grace not elapsed) → TERMINATED: skips grace period', async () => {
      // 1 hour in the future.
      const id = await createAtStatus('offboarding-future', 'OFFBOARDING', {
        gracePeriodMs: 60 * 60 * 1000,
      });
      const stub = createStubStorage();

      const result = await tenants.forceTerminate(
        db,
        id,
        'cannot wait for grace',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );
      expect(result.status).toBe('TERMINATED');

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED');
      const payload = event?.payload as {
        override_metadata: { skipped_grace_period: boolean };
      };
      expect(payload.override_metadata.skipped_grace_period).toBe(true);
    });

    it('OFFBOARDING (grace elapsed) → TERMINATED: skipped_grace_period=false', async () => {
      const id = await createAtStatus('offboarding-elapsed', 'OFFBOARDING');
      const stub = createStubStorage();

      await tenants.forceTerminate(
        db,
        id,
        'just confirming termination',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED');
      const payload = event?.payload as {
        override_metadata: { skipped_grace_period: boolean };
      };
      expect(payload.override_metadata.skipped_grace_period).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Audit shape
  // ───────────────────────────────────────────────────────────────────

  describe('audit shape', () => {
    it('emits TENANT_FORCE_TERMINATED (NOT TENANT_TERMINATED)', async () => {
      const id = await createAtStatus('audit-action-name', 'ACTIVE');
      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'audit assertion',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const actions = events.map((e) => e.action);
      expect(actions).toContain('TENANT_FORCE_TERMINATED');
      expect(actions).not.toContain('TENANT_TERMINATED');
    });

    it('audit payload captures the operator-supplied reason', async () => {
      const id = await createAtStatus('reason-capture', 'ACTIVE');
      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'super-admin invoked due to escalation SECOPS-9001',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED');
      const payload = event?.payload as { reason: string };
      expect(payload.reason).toBe('super-admin invoked due to escalation SECOPS-9001');
    });

    it('audit row carries the caller-supplied actor', async () => {
      const id = await createAtStatus('audit-actor', 'ACTIVE');
      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'actor attribution check',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED');
      expect(event?.actor_type).toBe(ACTOR.type);
      expect(event?.actor_id).toBe(ACTOR.id);
    });

    it('cascade_steps payload mirrors terminate (STANDARD: NA_STANDARD; ENTERPRISE would be STUB)', async () => {
      const id = await createAtStatus('cascade-steps', 'ACTIVE');
      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'cascade verification',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const payload = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED')?.payload as {
        cascade_steps: {
          cloud_run_delete: string;
          gcs_prefix_delete: string;
          cloud_sql_delete: string;
          shared_db_delete: string;
          kms_destroy: string;
        };
      };
      expect(payload.cascade_steps.cloud_run_delete).toBe('NA_STANDARD');
      expect(payload.cascade_steps.gcs_prefix_delete).toBe('EXECUTED');
      expect(payload.cascade_steps.cloud_sql_delete).toBe('NA_STANDARD');
      expect(payload.cascade_steps.shared_db_delete).toBe('EXECUTED');
      expect(payload.cascade_steps.kms_destroy).toBe('TOMBSTONE_ONLY_PHASE_1');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Override forensics
  // ───────────────────────────────────────────────────────────────────

  describe('override forensics', () => {
    it('without active hold: skipped_legal_hold=false; no active_legal_hold field', async () => {
      const id = await createAtStatus('no-hold', 'ACTIVE');
      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'no hold present',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const payload = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED')?.payload as {
        override_metadata: { skipped_legal_hold: boolean; active_legal_hold?: unknown };
      };
      expect(payload.override_metadata.skipped_legal_hold).toBe(false);
      expect(payload.override_metadata.active_legal_hold).toBeUndefined();
    });

    it('with active legal_hold table entry: captures scope+reason+setByUserId for forensics', async () => {
      const id = await createAtStatus('with-hold-table', 'ACTIVE');
      await legalHolds.set(
        db,
        id,
        {
          scope: 'tenant',
          reason: 'discovery freeze SECOPS-1234',
          setByUserId: 'workos_user_legal_dept',
        },
        { actor: ACTOR },
      );

      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'override reviewed by Super Admin',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const payload = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED')?.payload as {
        override_metadata: {
          skipped_legal_hold: boolean;
          active_legal_hold: { scope: string; reason: string; set_by_user_id: string };
        };
      };
      expect(payload.override_metadata.skipped_legal_hold).toBe(true);
      expect(payload.override_metadata.active_legal_hold.scope).toBe('tenant');
      expect(payload.override_metadata.active_legal_hold.reason).toBe(
        'discovery freeze SECOPS-1234',
      );
      expect(payload.override_metadata.active_legal_hold.set_by_user_id).toBe(
        'workos_user_legal_dept',
      );
    });

    it('with tenant.legal_hold=true (boolean fast path): tenant_legal_hold_boolean_was_set=true', async () => {
      const id = await createAtStatus('with-hold-boolean', 'ACTIVE', { legalHoldBoolean: true });
      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'bypassing the boolean fast path',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const events = await fetchAuditEvents(db, id);
      const payload = events.find((e) => e.action === 'TENANT_FORCE_TERMINATED')?.payload as {
        override_metadata: {
          skipped_legal_hold: boolean;
          tenant_legal_hold_boolean_was_set?: boolean;
        };
        before_state: { legal_hold: boolean };
      };
      expect(payload.override_metadata.skipped_legal_hold).toBe(true);
      expect(payload.override_metadata.tenant_legal_hold_boolean_was_set).toBe(true);
      expect(payload.before_state.legal_hold).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Idempotency
  // ───────────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('TERMINATED tenant: returns tombstone, no audit re-emit, no GCS delete', async () => {
      const id = await createAtStatus('idempotent', 'ACTIVE');
      const stub1 = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'first run',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub1 as never } },
      );
      const eventsAfterFirst = await fetchAuditEvents(db, id);

      const stub2 = createStubStorage();
      const result = await tenants.forceTerminate(
        db,
        id,
        'idempotent retry',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub2 as never } },
      );

      expect(result.status).toBe('TERMINATED');
      const eventsAfterSecond = await fetchAuditEvents(db, id);
      expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length);
      expect(stub2.__bucket.deleteFiles).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Errors
  // ───────────────────────────────────────────────────────────────────

  describe('errors', () => {
    it('TenantNotFoundError when id does not exist', async () => {
      const stub = createStubStorage();
      await expect(
        tenants.forceTerminate(
          db,
          randomUUID(),
          'reason',
          { actor: ACTOR },
          { cascadeOverrides: { storage: stub as never } },
        ),
      ).rejects.toThrow(TenantNotFoundError);
    });

    it('TenantValidationError when reason is empty', async () => {
      const id = await createAtStatus('bad-reason', 'ACTIVE');
      await expect(tenants.forceTerminate(db, id, '', { actor: ACTOR })).rejects.toThrow(
        TenantValidationError,
      );
    });

    it('TenantStatusError when status is PROVISIONING (pre-public)', async () => {
      const id = await createAtStatus('pre-public', 'PROVISIONING');
      const stub = createStubStorage();
      await expect(
        tenants.forceTerminate(
          db,
          id,
          'should fail',
          { actor: ACTOR },
          { cascadeOverrides: { storage: stub as never } },
        ),
      ).rejects.toThrow(TenantStatusError);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Soft-retain semantics (Q-NEW-C8)
  // ───────────────────────────────────────────────────────────────────

  describe('soft-retain semantics', () => {
    it('tombstone row remains; tenants.get throws TenantNotFoundError', async () => {
      const id = await createAtStatus('soft-retain', 'ACTIVE');
      const stub = createStubStorage();
      await tenants.forceTerminate(
        db,
        id,
        'soft-retain test',
        { actor: ACTOR },
        { cascadeOverrides: { storage: stub as never } },
      );

      const rows = await db.select().from(tenantTable).where(eq(tenantTable.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('TERMINATED');

      await expect(tenants.get(db, id)).rejects.toThrow(TenantNotFoundError);
    });
  });
});

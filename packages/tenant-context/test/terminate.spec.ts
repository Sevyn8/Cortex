/**
 * Tests for `tenants.terminate` (F02 Slice C — sub-phase 7.4).
 *
 * Verifies SC1 + SC4 + Q-NEW-C5 + Q-NEW-C8 + Q-NEW-C10 + Q-NEW-C11:
 *   - 5-step cascade with stub markers for Cloud Run + Cloud SQL,
 *     real GCS recursive delete, soft-retain tenant tombstone.
 *   - Legal-hold dual-source guard (boolean + table) blocks termination.
 *   - Strict grace-period check (`now() >= offboarding_grace_until`).
 *   - TENANT_TERMINATED audit emission with before_state +
 *     kms_key_resource_name + cascade_steps payload.
 *   - tenants.get / getByExternalId filter TERMINATED tombstones.
 *
 * Storage is stubbed via options.cascadeOverrides.storage; no real GCS
 * calls. DB hits the local Postgres (RLS bind required).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { tenant as tenantTable } from '@cortex/canonical-schema';
import { tenants } from '../src/tenants.js';
import {
  TenantGraceNotElapsedError,
  TenantLegalHoldError,
  TenantNotFoundError,
  TenantStatusError,
  TenantValidationError,
} from '../src/errors.js';
import { fetchAuditEvents } from './helpers/audit.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = { type: 'service' as const, id: 'terminate-spec', description: 'terminate test' };

interface StubBucket {
  deleteFiles: ReturnType<typeof vi.fn>;
}
interface StubStorage {
  bucket: ReturnType<typeof vi.fn>;
  __bucket: StubBucket;
}

function createStubStorage(): StubStorage {
  const bucket: StubBucket = {
    deleteFiles: vi.fn().mockResolvedValue(undefined),
  };
  return {
    bucket: vi.fn().mockReturnValue(bucket),
    __bucket: bucket,
  };
}

describe('tenants.terminate', () => {
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
        // ignore — children may already be deleted by terminate cascade
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function externalIdFor(label: string): string {
    return `test-terminate-${RUN_TAG}-${label}`;
  }

  /**
   * Create a tenant and put it in OFFBOARDING with an elapsed grace
   * period, so terminate's prerequisites are satisfied. Bypasses
   * tenants.offboard so we don't have to mock the export-archive +
   * Cloud Tasks paths in every test.
   */
  async function createOffboardingExpired(
    label: string,
    opts: { tier?: 'STANDARD' | 'ENTERPRISE'; legalHoldBoolean?: boolean } = {},
  ): Promise<string> {
    const created = await tenants.create(
      db,
      {
        externalId: externalIdFor(label),
        displayName: `Term ${label}`,
        tier: opts.tier ?? 'STANDARD',
        initialStatus: 'ACTIVE',
      },
      { actor: ACTOR },
    );
    createdTenantIds.push(created.id);
    // Manually advance to OFFBOARDING with an already-elapsed grace.
    const expiredGrace = new Date(Date.now() - 60_000); // 1 min ago
    await db
      .update(tenantTable)
      .set({
        status: 'OFFBOARDING',
        offboarding_grace_until: expiredGrace,
        ...(opts.legalHoldBoolean === true && { legal_hold: true }),
      })
      .where(eq(tenantTable.id, created.id));
    return created.id;
  }

  // ───────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('soft-retains tenant tombstone (status=TERMINATED, terminated_at set); children deleted', async () => {
      const id = await createOffboardingExpired('happy-1');
      const stub = createStubStorage();

      const result = await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      expect(result.status).toBe('TERMINATED');
      expect(result.terminated_at).not.toBeNull();
      expect(result.id).toBe(id);

      // Tombstone row still exists (tenant has no RLS — direct SELECT works).
      const rows = await db.select().from(tenantTable).where(eq(tenantTable.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('TERMINATED');

      // Children deleted. tenant_kms_key has RLS — bind to the (now-
      // terminated) tenant to read it; the SELECT returns 0 rows.
      let kmsCount = -1;
      await withBoundClient(pool, id, async (client) => {
        const r = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM tenant_kms_key WHERE tenant_id = $1`,
          [id],
        );
        kmsCount = Number(r.rows[0]?.n ?? -1);
      });
      expect(kmsCount).toBe(0);
    });

    it('GCS recursive delete called with the tenant prefix and force: true', async () => {
      const id = await createOffboardingExpired('gcs-1');
      const stub = createStubStorage();

      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      expect(stub.bucket).toHaveBeenCalledWith('cortex-dev-tenant-data');
      expect(stub.__bucket.deleteFiles).toHaveBeenCalledWith({
        prefix: `tenants/${id}/`,
        force: true,
      });
    });

    it('STANDARD tier: cascade_steps marks Cloud Run + Cloud SQL as NA_STANDARD', async () => {
      const id = await createOffboardingExpired('standard-1', { tier: 'STANDARD' });
      const stub = createStubStorage();

      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_TERMINATED');
      const payload = event?.payload as {
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

    it('ENTERPRISE tier: cascade_steps marks Cloud Run + Cloud SQL as STUB_TODO_ADR_INFRA_005', async () => {
      const id = await createOffboardingExpired('enterprise-1', { tier: 'ENTERPRISE' });
      const stub = createStubStorage();
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        await tenants.terminate(
          db,
          id,
          { actor: ACTOR },
          {
            cascadeOverrides: { storage: stub as never },
          },
        );

        const events = await fetchAuditEvents(db, id);
        const payload = events.find((e) => e.action === 'TENANT_TERMINATED')?.payload as {
          cascade_steps: { cloud_run_delete: string; cloud_sql_delete: string };
        };
        expect(payload.cascade_steps.cloud_run_delete).toBe('STUB_TODO_ADR_INFRA_005');
        expect(payload.cascade_steps.cloud_sql_delete).toBe('STUB_TODO_ADR_INFRA_005');

        // Operator-visible TODO markers logged to stderr.
        expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Audit emission
  // ───────────────────────────────────────────────────────────────────

  describe('audit emission', () => {
    it('emits TENANT_TERMINATED with before_state including tier, external_id, kms_key_resource_name', async () => {
      const id = await createOffboardingExpired('audit-1');
      const stub = createStubStorage();

      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_TERMINATED');
      expect(event).toBeDefined();
      const payload = event?.payload as {
        before_state: {
          status: string;
          tier: string;
          external_id: string;
          kms_key_resource_name: string | null;
        };
        kms_key_resource_name: string | null;
      };
      expect(payload.before_state.status).toBe('OFFBOARDING');
      expect(payload.before_state.tier).toBe('STANDARD');
      expect(payload.before_state.external_id).toContain('test-terminate-');
      expect(payload.before_state.kms_key_resource_name).toContain('cryptoKeys/cortex-general-key');
      // Top-level kms_key_resource_name (tombstone signal) mirrors before_state.
      expect(payload.kms_key_resource_name).toBe(payload.before_state.kms_key_resource_name);
    });

    it('audit row carries the caller-supplied actor', async () => {
      const id = await createOffboardingExpired('audit-actor-1');
      const stub = createStubStorage();

      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_TERMINATED');
      expect(event?.actor_type).toBe(ACTOR.type);
      expect(event?.actor_id).toBe(ACTOR.id);
    });

    it('DELETE-verb audit row has no after_state (per discriminated-union contract)', async () => {
      const id = await createOffboardingExpired('audit-no-after');
      const stub = createStubStorage();

      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_TERMINATED');
      expect(event).toBeDefined();
      const payload = event!.payload;
      // DELETE rows must not carry after_state.
      expect(payload.after_state).toBeUndefined();
    });

    it('audit chain (TENANT_CREATED, TENANT_KMS_KEY_BOUND, TENANT_TERMINATED) survives the cascade per ADR-DB-003', async () => {
      const id = await createOffboardingExpired('chain-1');
      const stub = createStubStorage();
      const eventsBefore = await fetchAuditEvents(db, id);
      const beforeCount = eventsBefore.length;

      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      const eventsAfter = await fetchAuditEvents(db, id);
      // No deletes — append-only. Just one new row.
      expect(eventsAfter.length).toBe(beforeCount + 1);
      expect(eventsAfter.map((e) => e.action)).toContain('TENANT_TERMINATED');
      expect(eventsAfter.map((e) => e.action)).toContain('TENANT_CREATED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Idempotency (SB5 Option α)
  // ───────────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('re-terminating a TERMINATED tombstone returns the row, no audit emit, no GCS delete', async () => {
      const id = await createOffboardingExpired('idempotent-1');
      const stub1 = createStubStorage();
      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub1 as never },
        },
      );
      const eventsAfterFirst = await fetchAuditEvents(db, id);

      const stub2 = createStubStorage();
      const second = await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub2 as never },
        },
      );

      expect(second.status).toBe('TERMINATED');
      // No new audit emission.
      const eventsAfterSecond = await fetchAuditEvents(db, id);
      expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length);
      // No GCS delete on the idempotent re-call.
      expect(stub2.__bucket.deleteFiles).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Prerequisite errors
  // ───────────────────────────────────────────────────────────────────

  describe('prerequisite errors', () => {
    it('TenantNotFoundError when id does not exist', async () => {
      const stub = createStubStorage();
      await expect(
        tenants.terminate(
          db,
          randomUUID(),
          { actor: ACTOR },
          {
            cascadeOverrides: { storage: stub as never },
          },
        ),
      ).rejects.toThrow(TenantNotFoundError);
    });

    it('TenantValidationError when id is not a UUID', async () => {
      await expect(tenants.terminate(db, 'not-a-uuid', { actor: ACTOR })).rejects.toThrow(
        TenantValidationError,
      );
    });

    it('TenantStatusError when status is ACTIVE (not OFFBOARDING)', async () => {
      const created = await tenants.create(
        db,
        {
          externalId: externalIdFor('not-offboarding'),
          displayName: 'Active',
          tier: 'STANDARD',
          initialStatus: 'ACTIVE',
        },
        { actor: ACTOR },
      );
      createdTenantIds.push(created.id);

      const stub = createStubStorage();
      await expect(
        tenants.terminate(
          db,
          created.id,
          { actor: ACTOR },
          {
            cascadeOverrides: { storage: stub as never },
          },
        ),
      ).rejects.toThrow(TenantStatusError);
    });

    it('TenantGraceNotElapsedError when grace period has not elapsed', async () => {
      const created = await tenants.create(
        db,
        {
          externalId: externalIdFor('grace-not-elapsed'),
          displayName: 'Pending',
          tier: 'STANDARD',
          initialStatus: 'ACTIVE',
        },
        { actor: ACTOR },
      );
      createdTenantIds.push(created.id);
      // 1 hour in the future.
      const futureGrace = new Date(Date.now() + 60 * 60 * 1000);
      await db
        .update(tenantTable)
        .set({ status: 'OFFBOARDING', offboarding_grace_until: futureGrace })
        .where(eq(tenantTable.id, created.id));

      const stub = createStubStorage();
      let captured: unknown;
      try {
        await tenants.terminate(
          db,
          created.id,
          { actor: ACTOR },
          {
            cascadeOverrides: { storage: stub as never },
          },
        );
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantGraceNotElapsedError);
      const e = captured as TenantGraceNotElapsedError;
      expect(e.tenantId).toBe(created.id);
      expect(e.graceUntil.toISOString()).toBe(futureGrace.toISOString());
      // Defense-in-depth: GCS delete must not have been invoked.
      expect(stub.__bucket.deleteFiles).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Legal-hold guards
  // ───────────────────────────────────────────────────────────────────

  describe('legal-hold guards', () => {
    it('tenant.legal_hold=true blocks termination (TenantLegalHoldError, scope=tenant)', async () => {
      const id = await createOffboardingExpired('legal-bool', { legalHoldBoolean: true });
      const stub = createStubStorage();

      let captured: unknown;
      try {
        await tenants.terminate(
          db,
          id,
          { actor: ACTOR },
          {
            cascadeOverrides: { storage: stub as never },
          },
        );
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantLegalHoldError);
      const e = captured as TenantLegalHoldError;
      expect(e.holdScope).toBe('tenant');
      expect(e.tenantId).toBe(id);
      // Defense-in-depth: GCS delete must not have been invoked.
      expect(stub.__bucket.deleteFiles).not.toHaveBeenCalled();
    });

    it('active legal_hold table entry blocks termination with structured fields', async () => {
      const id = await createOffboardingExpired('legal-table-active');
      // Insert a granular hold (record scope) under tenant binding.
      await withBoundClient(pool, id, async (client) => {
        await client.query(
          `INSERT INTO legal_hold (tenant_id, scope, record_id, reason, set_by_user_id)
             VALUES ($1, 'record', gen_random_uuid(), 'litigation discovery', 'workos_user_legal')`,
          [id],
        );
      });

      const stub = createStubStorage();
      let captured: unknown;
      try {
        await tenants.terminate(
          db,
          id,
          { actor: ACTOR },
          {
            cascadeOverrides: { storage: stub as never },
          },
        );
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(TenantLegalHoldError);
      const e = captured as TenantLegalHoldError;
      expect(e.holdScope).toBe('record');
      expect(e.holdReason).toBe('litigation discovery');
      expect(e.setByUserId).toBe('workos_user_legal');
      expect(stub.__bucket.deleteFiles).not.toHaveBeenCalled();
    });

    it('released legal_hold entry does NOT block (released_at IS NOT NULL)', async () => {
      const id = await createOffboardingExpired('legal-released');
      await withBoundClient(pool, id, async (client) => {
        await client.query(
          `INSERT INTO legal_hold (tenant_id, scope, reason, set_by_user_id, released_at, released_by_user_id)
             VALUES ($1, 'tenant', 'old hold', 'workos_user_set', now(), 'workos_user_release')`,
          [id],
        );
      });

      const stub = createStubStorage();
      const result = await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );
      expect(result.status).toBe('TERMINATED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Post-termination read-path filtering (Q-NEW-C8)
  // ───────────────────────────────────────────────────────────────────

  describe('post-termination read-path filtering', () => {
    it('tenants.get throws TenantNotFoundError on a TERMINATED tombstone', async () => {
      const id = await createOffboardingExpired('get-filter');
      const stub = createStubStorage();
      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      await expect(tenants.get(db, id)).rejects.toThrow(TenantNotFoundError);
    });

    it('tenants.getByExternalId throws TenantNotFoundError on a TERMINATED tombstone', async () => {
      const id = await createOffboardingExpired('get-ext-filter');
      const externalId = externalIdFor('get-ext-filter');
      const stub = createStubStorage();
      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      await expect(tenants.getByExternalId(db, externalId)).rejects.toThrow(TenantNotFoundError);
    });

    it('tombstone is still visible via direct SQL (intentional — operator forensics)', async () => {
      const id = await createOffboardingExpired('forensic-read');
      const stub = createStubStorage();
      await tenants.terminate(
        db,
        id,
        { actor: ACTOR },
        {
          cascadeOverrides: { storage: stub as never },
        },
      );

      const rows = await db.select().from(tenantTable).where(eq(tenantTable.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('TERMINATED');
      expect(rows[0]?.terminated_at).not.toBeNull();
    });
  });
});

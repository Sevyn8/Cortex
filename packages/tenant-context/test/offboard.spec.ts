/**
 * Tests for `tenants.offboard` (F02 Slice C).
 *
 * Verifies SC1 workflow shape: state transition, grace_until column,
 * archive generation, delayed Cloud Task dispatch on `lifecycle-queue`,
 * `TENANT_OFFBOARDING_STARTED` audit event with archive metadata
 * (signedUrl excluded for credential-leak hygiene).
 *
 * Mirrors `suspend-resume.spec.ts` patterns. Cloud Tasks SDK + Storage
 * are stubbed via `__setClientForTesting` and `options.storage`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { tenants } from '../src/tenants.js';
import { __setClientForTesting } from '../src/cloud-tasks.js';
import { TenantNotFoundError, TenantStatusError, TenantValidationError } from '../src/errors.js';
import { fetchAuditEvents } from './helpers/audit.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = { type: 'service' as const, id: 'offboard-spec', description: 'offboard test' };

interface MockClient {
  createTask: ReturnType<typeof vi.fn>;
  queuePath: ReturnType<typeof vi.fn>;
  taskPath: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockClient {
  return {
    createTask: vi.fn().mockResolvedValue([{ name: 'projects/x/tasks/y' }]),
    queuePath: vi
      .fn()
      .mockImplementation(
        (project: string, location: string, queue: string) =>
          `projects/${project}/locations/${location}/queues/${queue}`,
      ),
    taskPath: vi
      .fn()
      .mockImplementation(
        (project: string, location: string, queue: string, taskId: string) =>
          `projects/${project}/locations/${location}/queues/${queue}/tasks/${taskId}`,
      ),
  };
}

interface StubFile {
  save: ReturnType<typeof vi.fn>;
  getSignedUrl: ReturnType<typeof vi.fn>;
}

interface StubStorage {
  bucket: ReturnType<typeof vi.fn>;
  __file: StubFile;
}

function createStubStorage(): StubStorage {
  const file: StubFile = {
    save: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi.fn().mockResolvedValue(['https://storage.googleapis.com/signed-url-stub']),
  };
  const bucket = { file: vi.fn().mockReturnValue(file) };
  return {
    bucket: vi.fn().mockReturnValue(bucket),
    __file: file,
  };
}

describe('tenants.offboard', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  let mockClient: MockClient;
  let stubStorage: StubStorage;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    process.env.CORTEX_ENV = 'dev';
    pool = getPool();
    db = drizzle(pool);
    await forceRlsOnAuditEvent(pool);
  });

  beforeEach(() => {
    process.env.LIFECYCLE_WORKER_URL = 'https://lifecycle-worker.example.com';
    mockClient = createMockClient();
    __setClientForTesting(mockClient as unknown as CloudTasksClient);
    stubStorage = createStubStorage();
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
    return `test-offboard-${RUN_TAG}-${label}`;
  }

  async function createAtStatus(
    label: string,
    initialStatus: 'ACTIVE' | 'SUSPENDED' | 'PROVISIONING' | 'TERMINATED',
  ): Promise<string> {
    const created = await tenants.create(
      db,
      {
        externalId: externalIdFor(label),
        displayName: `Off ${label}`,
        tier: 'STANDARD',
        initialStatus,
      },
      { actor: ACTOR },
    );
    createdTenantIds.push(created.id);
    return created.id;
  }

  function offboardArgs() {
    return { archiveOverrides: { storage: stubStorage as never } };
  }

  // ───────────────────────────────────────────────────────────────────
  // Happy paths
  // ───────────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('flips ACTIVE → OFFBOARDING, sets grace_until, returns archive metadata', async () => {
      const id = await createAtStatus('happy-active', 'ACTIVE');
      const start = Date.now();

      const result = await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      expect(result.tenant.status).toBe('OFFBOARDING');
      expect(result.tenant.offboarding_grace_until).not.toBeNull();
      expect(result.exportArchive).toBeDefined();
      expect(result.exportArchive?.gcsUri).toMatch(
        /^gs:\/\/cortex-dev-tenant-data\/tenants\/[0-9a-f-]+\/exports\//,
      );
      // Default 30-day grace.
      const graceMs = result.graceUntil.getTime() - start;
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(graceMs).toBeGreaterThan(thirtyDaysMs - 5000);
      expect(graceMs).toBeLessThanOrEqual(thirtyDaysMs + 5000);
    });

    it('flips SUSPENDED → OFFBOARDING via the alt path', async () => {
      const id = await createAtStatus('happy-suspended', 'SUSPENDED');

      const result = await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      expect(result.tenant.status).toBe('OFFBOARDING');
      const events = await fetchAuditEvents(db, id);
      const offboardEvent = events.find((e) => e.action === 'TENANT_OFFBOARDING_STARTED');
      expect(offboardEvent).toBeDefined();
      expect(
        (offboardEvent?.payload as { before_state: { status: string } }).before_state.status,
      ).toBe('SUSPENDED');
    });

    it('respects custom gracePeriodDays', async () => {
      const id = await createAtStatus('grace-7', 'ACTIVE');
      const start = Date.now();

      const result = await tenants.offboard(
        db,
        id,
        { gracePeriodDays: 7, archiveOverrides: { storage: stubStorage as never } },
        { actor: ACTOR },
      );

      const graceMs = result.graceUntil.getTime() - start;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(graceMs).toBeGreaterThan(sevenDaysMs - 5000);
      expect(graceMs).toBeLessThanOrEqual(sevenDaysMs + 5000);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Audit emission
  // ───────────────────────────────────────────────────────────────────

  describe('audit emission', () => {
    it('emits TENANT_OFFBOARDING_STARTED with archive gcsUri but NOT signedUrl', async () => {
      const id = await createAtStatus('audit-1', 'ACTIVE');
      await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_OFFBOARDING_STARTED');
      expect(event).toBeDefined();
      const payload = event?.payload as {
        gracePeriodDays: number;
        exportArchive: { gcsUri: string; sizeBytes: number; signedUrl?: string };
      };
      expect(payload.gracePeriodDays).toBe(30);
      expect(payload.exportArchive.gcsUri).toContain('gs://');
      expect(payload.exportArchive.sizeBytes).toBeGreaterThan(0);
      // Critical security invariant: signedUrl MUST NOT be in audit row.
      expect(payload.exportArchive.signedUrl).toBeUndefined();
    });

    it('audit row carries the caller-supplied actor', async () => {
      const id = await createAtStatus('audit-actor-1', 'ACTIVE');
      await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_OFFBOARDING_STARTED');
      expect(event?.actor_type).toBe(ACTOR.type);
      expect(event?.actor_id).toBe(ACTOR.id);
    });

    it('audit row before/after captures the status delta + grace_until', async () => {
      const id = await createAtStatus('audit-delta-1', 'ACTIVE');
      const result = await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      const events = await fetchAuditEvents(db, id);
      const event = events.find((e) => e.action === 'TENANT_OFFBOARDING_STARTED');
      const payload = event?.payload as {
        before_state: { status: string };
        after_state: { status: string; offboarding_grace_until: string };
      };
      expect(payload.before_state.status).toBe('ACTIVE');
      expect(payload.after_state.status).toBe('OFFBOARDING');
      expect(payload.after_state.offboarding_grace_until).toBe(result.graceUntil.toISOString());
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Cloud Tasks dispatch
  // ───────────────────────────────────────────────────────────────────

  describe('Cloud Tasks dispatch', () => {
    it('enqueues on lifecycle-queue with taskId terminate-{tenantId}', async () => {
      const id = await createAtStatus('dispatch-1', 'ACTIVE');
      await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      expect(mockClient.queuePath).toHaveBeenCalledWith(
        'sevyn8-cortex-dev',
        'asia-south1',
        'lifecycle-queue',
      );
      expect(mockClient.taskPath).toHaveBeenCalledWith(
        'sevyn8-cortex-dev',
        'asia-south1',
        'lifecycle-queue',
        `terminate-${id}`,
      );
    });

    it('scheduleTime equals graceUntil (delayed terminate)', async () => {
      const id = await createAtStatus('dispatch-schedule-1', 'ACTIVE');
      const result = await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { scheduleTime: { seconds: number; nanos: number } };
      };
      const expectedSeconds = Math.floor(result.graceUntil.getTime() / 1000);
      const expectedNanos = (result.graceUntil.getTime() % 1000) * 1_000_000;
      expect(callArg.task.scheduleTime.seconds).toBe(expectedSeconds);
      expect(callArg.task.scheduleTime.nanos).toBe(expectedNanos);
    });

    it('payload carries tenantId + action=terminate + offboardingGraceUntil', async () => {
      const id = await createAtStatus('dispatch-payload-1', 'ACTIVE');
      const result = await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { httpRequest: { body: string } };
      };
      const decoded = JSON.parse(
        Buffer.from(callArg.task.httpRequest.body, 'base64').toString('utf8'),
      ) as { tenantId: string; action: string; offboardingGraceUntil: string };
      expect(decoded.tenantId).toBe(id);
      expect(decoded.action).toBe('terminate');
      expect(decoded.offboardingGraceUntil).toBe(result.graceUntil.toISOString());
    });

    it('throws if LIFECYCLE_WORKER_URL is missing', async () => {
      const id = await createAtStatus('dispatch-no-url', 'ACTIVE');
      delete process.env.LIFECYCLE_WORKER_URL;

      await expect(tenants.offboard(db, id, offboardArgs(), { actor: ACTOR })).rejects.toThrow(
        /LIFECYCLE_WORKER_URL env required/,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Idempotency (SB5 Option α — fast-path)
  // ───────────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('re-offboarding an OFFBOARDING tenant returns current row + undefined archive (no audit re-emit)', async () => {
      const id = await createAtStatus('idempotent-1', 'ACTIVE');
      const first = await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });
      const eventsAfterFirst = await fetchAuditEvents(db, id);
      const firstOffboardEventCount = eventsAfterFirst.filter(
        (e) => e.action === 'TENANT_OFFBOARDING_STARTED',
      ).length;

      // Reset Cloud Tasks mock to count just the second call's dispatches.
      mockClient.createTask.mockClear();
      stubStorage.__file.save.mockClear();

      const second = await tenants.offboard(db, id, offboardArgs(), { actor: ACTOR });

      expect(second.tenant.status).toBe('OFFBOARDING');
      expect(second.exportArchive).toBeUndefined();
      expect(second.graceUntil.toISOString()).toBe(first.graceUntil.toISOString());

      // No audit re-emission, no new archive, no new task dispatch.
      const eventsAfterSecond = await fetchAuditEvents(db, id);
      const secondOffboardEventCount = eventsAfterSecond.filter(
        (e) => e.action === 'TENANT_OFFBOARDING_STARTED',
      ).length;
      expect(secondOffboardEventCount).toBe(firstOffboardEventCount);
      expect(stubStorage.__file.save).not.toHaveBeenCalled();
      expect(mockClient.createTask).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Error paths
  // ───────────────────────────────────────────────────────────────────

  describe('errors', () => {
    it('TenantNotFoundError when id does not exist', async () => {
      await expect(
        tenants.offboard(db, randomUUID(), offboardArgs(), { actor: ACTOR }),
      ).rejects.toThrow(TenantNotFoundError);
    });

    it('TenantValidationError when id is not a UUID', async () => {
      await expect(
        tenants.offboard(db, 'not-a-uuid', offboardArgs(), { actor: ACTOR }),
      ).rejects.toThrow(TenantValidationError);
    });

    it('TenantValidationError for gracePeriodDays = 0', async () => {
      const id = await createAtStatus('bad-grace-0', 'ACTIVE');
      await expect(
        tenants.offboard(
          db,
          id,
          { gracePeriodDays: 0, archiveOverrides: { storage: stubStorage as never } },
          { actor: ACTOR },
        ),
      ).rejects.toThrow(TenantValidationError);
    });

    it('TenantValidationError for gracePeriodDays > 365', async () => {
      const id = await createAtStatus('bad-grace-366', 'ACTIVE');
      await expect(
        tenants.offboard(
          db,
          id,
          { gracePeriodDays: 366, archiveOverrides: { storage: stubStorage as never } },
          { actor: ACTOR },
        ),
      ).rejects.toThrow(TenantValidationError);
    });

    it('TenantStatusError when current status disallows OFFBOARDING (PROVISIONING)', async () => {
      const id = await createAtStatus('bad-state-prov', 'PROVISIONING');
      await expect(tenants.offboard(db, id, offboardArgs(), { actor: ACTOR })).rejects.toThrow(
        TenantStatusError,
      );
    });

    it('TenantStatusError when tenant is already TERMINATED', async () => {
      const id = await createAtStatus('bad-state-term', 'TERMINATED');
      await expect(tenants.offboard(db, id, offboardArgs(), { actor: ACTOR })).rejects.toThrow(
        TenantStatusError,
      );
    });
  });
});

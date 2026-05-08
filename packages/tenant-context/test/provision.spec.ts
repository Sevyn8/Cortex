/**
 * Tests for `tenants.provision` — the synchronous-enqueue half of F02
 * Slice A's provisioning workflow. Verifies tier branching for
 * `initialStatus`, Cloud Tasks dispatch params, env requirements, and
 * audit chain emission (substrate-only — TENANT_PROVISIONED is the
 * worker's responsibility, not provision's).
 *
 * Mocks `@google-cloud/tasks` via `__setClientForTesting` per planning-
 * doc SA4 (worker-direct unit tests; SDK mock for integration shape).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { tenants } from '../src/tenants.js';
import { __setClientForTesting } from '../src/cloud-tasks.js';
import { fetchAuditEvents } from './helpers/audit.js';
import { forceRlsOnAuditEvent, getPool, withBoundClient } from './helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);
const ACTOR = { type: 'service' as const, id: 'provision-spec', description: 'provision test' };

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

describe('tenants.provision', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  let mockClient: MockClient;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    pool = getPool();
    db = drizzle(pool);
  });

  beforeEach(async () => {
    process.env.PROVISIONING_WORKER_URL = 'https://provisioning-worker.example.com';
    mockClient = createMockClient();
    __setClientForTesting(mockClient as unknown as CloudTasksClient);
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
        // tenant may not exist; ignore
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function trackTenant(id: string) {
    createdTenantIds.push(id);
  }

  function externalIdFor(label: string): string {
    return `test-provision-${RUN_TAG}-${label}`;
  }

  // ───────────────────────────────────────────────────────────────────
  // Tier branching for initialStatus (Q-OPEN-6 / SA12)
  // ───────────────────────────────────────────────────────────────────

  describe('tier branching', () => {
    it('Standard tenant lands at status=PROVISIONING (worker advances immediately)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('std-1'), displayName: 'Std One', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      expect(result.status).toBe('PROVISIONING');
      const t = await tenants.get(db, result.tenantId);
      expect(t.status).toBe('PROVISIONING');
      expect(t.tier).toBe('STANDARD');
      expect(t.dedicated_db_approved).toBe(false);
    });

    it('Enterprise tenant lands at status=REQUESTED (Q-OPEN-6 manual approval gate)', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('ent-1'), displayName: 'Ent One', tier: 'ENTERPRISE' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      expect(result.status).toBe('REQUESTED');
      const t = await tenants.get(db, result.tenantId);
      expect(t.status).toBe('REQUESTED');
      expect(t.tier).toBe('ENTERPRISE');
      expect(t.dedicated_db_approved).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Cloud Tasks dispatch contract
  // ───────────────────────────────────────────────────────────────────

  describe('Cloud Tasks dispatch', () => {
    it('enqueues exactly one task on the provisioning-queue', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('dispatch-1'), displayName: 'D1', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      expect(mockClient.createTask).toHaveBeenCalledOnce();
      expect(mockClient.queuePath).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'provisioning-queue',
      );
    });

    it('uses canonical taskId format provisioning-{tenantId} for dedup', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('dispatch-2'), displayName: 'D2', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      expect(mockClient.taskPath).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'provisioning-queue',
        `provisioning-${result.tenantId}`,
      );
    });

    it('targets PROVISIONING_WORKER_URL for the worker dispatch', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('dispatch-3'), displayName: 'D3', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { httpRequest: { url: string } };
      };
      expect(callArg.task.httpRequest.url).toBe('https://provisioning-worker.example.com');
    });

    it('payload base64-encodes tenant_id + actor metadata in snake_case wire format', async () => {
      // Wire format is snake_case per convention §7.4.0 (D.4.5). The
      // worker route's zod body schema validates snake_case + transforms
      // to camelCase `ProvisioningTaskPayload` before invoking the
      // library function. Aligns with the key-rotation worker route.
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('dispatch-4'), displayName: 'D4', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
        task: { httpRequest: { body: string } };
      };
      const decoded = JSON.parse(
        Buffer.from(callArg.task.httpRequest.body, 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      expect(decoded.tenant_id).toBe(result.tenantId);
      expect(decoded.actor_type).toBe(ACTOR.type);
      expect(decoded.actor_id).toBe(ACTOR.id);
      expect(decoded.actor_description).toBe(ACTOR.description);
    });

    it('attaches oidcToken when CLOUD_TASKS_INVOKER_SA_EMAIL is set', async () => {
      // OIDC dispatch path — required for Cloud Run invoker IAM (D.5+).
      // Without the env var, the spread is a no-op (pre-D.5 path); with
      // it set, dispatchCloudTask attaches an oidcToken with the SA
      // email. Surfaced as a real gap in D.4.5 gate evidence.
      const previous = process.env.CLOUD_TASKS_INVOKER_SA_EMAIL;
      process.env.CLOUD_TASKS_INVOKER_SA_EMAIL =
        'tenant-lifecycle-runtime@sevyn8-cortex-dev.iam.gserviceaccount.com';
      try {
        const result = await tenants.provision(
          db,
          { externalId: externalIdFor('dispatch-oidc'), displayName: 'OIDC', tier: 'STANDARD' },
          { actor: ACTOR },
        );
        trackTenant(result.tenantId);

        const callArg = mockClient.createTask.mock.calls[0]?.[0] as {
          task: { httpRequest: { oidcToken?: { serviceAccountEmail: string } } };
        };
        expect(callArg.task.httpRequest.oidcToken?.serviceAccountEmail).toBe(
          'tenant-lifecycle-runtime@sevyn8-cortex-dev.iam.gserviceaccount.com',
        );
      } finally {
        if (previous === undefined) {
          delete process.env.CLOUD_TASKS_INVOKER_SA_EMAIL;
        } else {
          process.env.CLOUD_TASKS_INVOKER_SA_EMAIL = previous;
        }
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Env requirements
  // ───────────────────────────────────────────────────────────────────

  describe('env requirements', () => {
    it('throws when PROVISIONING_WORKER_URL env is missing', async () => {
      delete process.env.PROVISIONING_WORKER_URL;
      await expect(
        tenants.provision(
          db,
          { externalId: externalIdFor('no-worker-url'), displayName: 'X', tier: 'STANDARD' },
          { actor: ACTOR },
        ),
      ).rejects.toThrow(/PROVISIONING_WORKER_URL env required/);
    });

    it('throws when PROVISIONING_WORKER_URL env is empty string', async () => {
      process.env.PROVISIONING_WORKER_URL = '';
      await expect(
        tenants.provision(
          db,
          { externalId: externalIdFor('empty-worker-url'), displayName: 'X', tier: 'STANDARD' },
          { actor: ACTOR },
        ),
      ).rejects.toThrow(/PROVISIONING_WORKER_URL env required/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Audit chain — substrate emission preserved (worker emits TENANT_PROVISIONED later)
  // ───────────────────────────────────────────────────────────────────

  describe('audit chain (substrate emission)', () => {
    it('emits TENANT_CREATED + TENANT_KMS_KEY_BOUND; does NOT emit TENANT_PROVISIONED', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('audit-1'), displayName: 'A1', tier: 'STANDARD' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      const events = await fetchAuditEvents(db, result.tenantId);
      const actions = events.map((e) => e.action);
      expect(actions).toContain('TENANT_CREATED');
      expect(actions).toContain('TENANT_KMS_KEY_BOUND');
      // TENANT_PROVISIONED fires from the worker once status reaches READY;
      // it must NOT appear from the synchronous provision call alone.
      expect(actions).not.toContain('TENANT_PROVISIONED');
    });

    it('TENANT_CREATED captures Enterprise initialStatus=REQUESTED in after_state', async () => {
      const result = await tenants.provision(
        db,
        { externalId: externalIdFor('audit-ent'), displayName: 'AE', tier: 'ENTERPRISE' },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      const events = await fetchAuditEvents(db, result.tenantId);
      const created = events.find((e) => e.action === 'TENANT_CREATED');
      expect(created).toBeDefined();
      expect(created?.payload).toMatchObject({
        after_state: {
          tier: 'ENTERPRISE',
          status: 'REQUESTED',
        },
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Initial config pass-through
  // ───────────────────────────────────────────────────────────────────

  describe('initialConfig pass-through', () => {
    it('passes initialConfig through to tenants.create (TENANT_CONFIG_VERSION_CREATED appears in chain)', async () => {
      const result = await tenants.provision(
        db,
        {
          externalId: externalIdFor('with-config'),
          displayName: 'W/Config',
          tier: 'STANDARD',
          initialConfig: { foo: 'bar' },
        },
        { actor: ACTOR },
      );
      trackTenant(result.tenantId);

      const events = await fetchAuditEvents(db, result.tenantId);
      expect(events.map((e) => e.action)).toContain('TENANT_CONFIG_VERSION_CREATED');
    });
  });
});

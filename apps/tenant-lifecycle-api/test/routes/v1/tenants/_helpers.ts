/**
 * Shared fixtures + factories for the v1/tenants endpoint tests.
 *
 * Per HOLD-checkpoint operator decision, each endpoint gets its own
 * spec file under apps/tenant-lifecycle-api/test/routes/v1/tenants/
 * for vitest worker-isolation + clean per-endpoint navigation. The
 * common machinery (real Postgres pool, KMS stub, app factory, seed
 * helpers) lives here.
 */
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { Hono, type MiddlewareHandler } from 'hono';
import { problemDetailsHandler } from 'hono-problem-details';
import type { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { __setClientFactoryForTesting } from '@cortex/secrets';
import { __setCloudTasksClientForTesting, tenants, type Actor } from '@cortex/tenant-context';
import { mapError } from '../../../../src/error-mapper.js';
import { buildV1TenantRoutes } from '../../../../src/routes/v1/tenants.js';
import { getPool } from '../../../../../../packages/tenant-context/test/helpers/db.js';

export const ACTOR: Actor = {
  type: 'service',
  id: 'd3-spec',
  description: 'D.3 test',
};

/**
 * Per-process run tag — appended to externalIds so parallel test
 * runs don't collide on the unique constraint. Each spec file imports
 * its own tag (re-call `mintRunTag()` per file) so a flake in one
 * file doesn't poison fixtures in another.
 */
export function mintRunTag(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export interface KmsStub {
  encrypt: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
  getCryptoKey: ReturnType<typeof vi.fn>;
  createCryptoKeyVersion: ReturnType<typeof vi.fn>;
  updateCryptoKeyPrimaryVersion: ReturnType<typeof vi.fn>;
  destroyCryptoKeyVersion: ReturnType<typeof vi.fn>;
}

export function inMemoryKms(): KmsStub {
  const versionCounter = new Map<string, number>();
  return {
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    getCryptoKey: vi.fn((req: { name?: string }) => {
      const key = req.name ?? '';
      const v = versionCounter.get(key) ?? 1;
      return Promise.resolve([{ name: key, primary: { name: `${key}/cryptoKeyVersions/${v}` } }]);
    }),
    createCryptoKeyVersion: vi.fn((req: { parent?: string }) => {
      const parent = req.parent ?? '';
      const next = (versionCounter.get(parent) ?? 1) + 1;
      return Promise.resolve([{ name: `${parent}/cryptoKeyVersions/${next}` }]);
    }),
    updateCryptoKeyPrimaryVersion: vi.fn((req: { name?: string; cryptoKeyVersionId?: string }) => {
      const key = req.name ?? '';
      const v = parseInt(req.cryptoKeyVersionId ?? '', 10);
      if (!Number.isNaN(v)) versionCounter.set(key, v);
      return Promise.resolve([{}]);
    }),
    destroyCryptoKeyVersion: vi.fn(() => Promise.resolve([{}])),
  };
}

export function buildTestApp(opts: {
  pool: Pool;
  superAdminGuard?: MiddlewareHandler;
  testHooks?: { storage?: unknown };
}): Hono {
  const app = new Hono();
  app.route(
    '/',
    buildV1TenantRoutes({
      pool: opts.pool,
      ...(opts.superAdminGuard !== undefined && { superAdminGuard: opts.superAdminGuard }),
      ...(opts.testHooks !== undefined && { testHooks: opts.testHooks as never }),
    }),
  );
  app.onError(
    problemDetailsHandler({
      mapError: (err) => mapError(err),
      autoInstance: true,
    }),
  );
  return app;
}

/**
 * Fake @google-cloud/storage `Storage` covering the surface the
 * tenant cascade workflows exercise — terminate / force-terminate
 * use `bucket().deleteFiles({prefix, force})`; offboard's archive
 * uses `bucket().file().save(buffer, options)` + `getSignedUrl(opts)`.
 *
 * D.4.5 deferred + D.6 lands. Cast to `Storage` at the call site:
 * the type surface is broad but the runtime methods we hit are
 * narrow — see the methods enumerated below.
 *
 * Each per-call invocation is recorded for test assertions
 * (`storage.calls`).
 */
export interface InMemoryStorage {
  calls: { method: string; args: unknown[] }[];
  bucket(name: string): {
    deleteFiles(opts: { prefix?: string; force?: boolean }): Promise<unknown>;
    file(path: string): {
      save(buffer: Buffer, options: unknown): Promise<unknown>;
      getSignedUrl(opts: unknown): Promise<[string]>;
    };
  };
}

export function inMemoryStorage(): InMemoryStorage {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    bucket(name: string) {
      return {
        deleteFiles(opts: { prefix?: string; force?: boolean }) {
          calls.push({ method: 'deleteFiles', args: [name, opts] });
          return Promise.resolve(undefined);
        },
        file(path: string) {
          return {
            save(buffer: Buffer, options: unknown) {
              calls.push({ method: 'save', args: [name, path, buffer.length, options] });
              return Promise.resolve(undefined);
            },
            getSignedUrl(opts: unknown): Promise<[string]> {
              calls.push({ method: 'getSignedUrl', args: [name, path, opts] });
              return Promise.resolve([`https://signed-url-stub/${name}/${path}`]);
            },
          };
        },
      };
    },
  };
}

/**
 * Always-reject super-admin guard for testing. Verifies that the
 * three guarded endpoints (GET /v1/tenants list, force-terminate,
 * approve-dedicated-db) actually have the middleware in their chain
 * — Phase 1's default placeholder always passes, so without DI we
 * couldn't structurally test the wiring.
 */
export const REJECTING_SUPER_ADMIN_GUARD: MiddlewareHandler = (c) =>
  Promise.resolve(c.json({ code: 'FORBIDDEN', message: 'super-admin scope required' }, 403));

/** Standard pool + drizzle setup. Caller manages lifetime. */
export function setupTestPool(): { pool: Pool; db: NodePgDatabase<Record<string, never>> } {
  process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
  const pool = getPool();
  const db = drizzle(pool);
  return { pool, db };
}

/**
 * Per-spec cleanup. Iterates createdTenantIds + DELETEs RLS-protected
 * children inside a bound txn, then DELETEs the tenant row.
 */
export async function cleanupTenants(pool: Pool, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        await client.query('DELETE FROM legal_hold WHERE tenant_id = $1', [id]);
        await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
        await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [id]);
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } catch {
      // ignore — best-effort cleanup
    }
    await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
  }
}

/** KMS stub lifecycle bound to per-test scope. */
export function withKmsStub(): void {
  __setClientFactoryForTesting(() => inMemoryKms() as never);
}

export function clearKmsStub(): void {
  __setClientFactoryForTesting(null);
}

/**
 * Cloud Tasks stub for endpoints whose handlers dispatch tasks
 * (currently `tenants.provision` from POST /v1/tenants). Sets
 * `PROVISIONING_WORKER_URL` to a fake URL + injects a mock client
 * whose `createTask` resolves successfully. Mirrors the pattern in
 * `packages/tenant-context/test/provision.spec.ts` (lines 62-64);
 * the re-export in `@cortex/tenant-context`'s barrel
 * (`__setCloudTasksClientForTesting`) is the package-boundary seam.
 *
 * Other spec files (terminate / force-terminate / approve-dedicated-db)
 * don't need this — their happy paths either short-circuit before
 * dispatch (409 cases) or are skipped (offboard).
 */
const FAKE_PROVISIONING_WORKER_URL = 'http://test-cloud-tasks.invalid/v1/_workers/provision';

interface CloudTasksStub {
  createTask: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  queuePath: ReturnType<typeof vi.fn>;
  taskPath: ReturnType<typeof vi.fn>;
}

function inMemoryCloudTasks(): CloudTasksStub {
  return {
    createTask: vi.fn().mockResolvedValue([{ name: 'projects/test/tasks/test-task' }]),
    close: vi.fn(),
    queuePath: vi.fn(
      (project: string, location: string, queue: string) =>
        `projects/${project}/locations/${location}/queues/${queue}`,
    ),
    taskPath: vi.fn(
      (project: string, location: string, queue: string, task: string) =>
        `projects/${project}/locations/${location}/queues/${queue}/tasks/${task}`,
    ),
  };
}

export function withCloudTasksStub(): void {
  process.env.PROVISIONING_WORKER_URL = FAKE_PROVISIONING_WORKER_URL;
  __setCloudTasksClientForTesting(inMemoryCloudTasks() as never);
}

export function clearCloudTasksStub(): void {
  delete process.env.PROVISIONING_WORKER_URL;
  __setCloudTasksClientForTesting(null);
}

/** Seed helpers — return tenant id; caller pushes to a tracker for cleanup. */
export async function seedActiveTenant(args: {
  db: NodePgDatabase<Record<string, never>>;
  externalId: string;
  displayName?: string;
}): Promise<string> {
  const created = await tenants.create(
    args.db,
    {
      externalId: args.externalId,
      displayName: args.displayName ?? `Test ${args.externalId}`,
      tier: 'STANDARD',
      initialStatus: 'ACTIVE',
    },
    { actor: ACTOR },
  );
  return created.id;
}

export async function seedEnterpriseRequestedTenant(args: {
  db: NodePgDatabase<Record<string, never>>;
  externalId: string;
  displayName?: string;
}): Promise<string> {
  const created = await tenants.create(
    args.db,
    {
      externalId: args.externalId,
      displayName: args.displayName ?? `Test ENT ${args.externalId}`,
      tier: 'ENTERPRISE',
      initialStatus: 'REQUESTED',
    },
    { actor: ACTOR },
  );
  return created.id;
}

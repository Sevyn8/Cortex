/**
 * POST /v1/tenants/:id/offboard.
 *
 * Happy path: ACTIVE tenant → 202 + grace_until set + GCS archive
 * created. D.4.5 deferred this; D.6 ships the route-level testHooks
 * seam so the `archiveOverrides.storage` library DI can be reached
 * from the HTTP wrapper without live GCS.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  buildTestApp,
  cleanupTenants,
  clearKmsStub,
  clearCloudTasksStub,
  inMemoryStorage,
  mintRunTag,
  seedActiveTenant,
  setupTestPool,
  withCloudTasksStub,
  withKmsStub,
} from './_helpers.js';

const RUN_TAG = mintRunTag('d6-offboard');

describe('POST /v1/tenants/:id/offboard', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    process.env.LIFECYCLE_WORKER_URL ??= 'http://test-cloud-tasks.invalid/v1/_workers/lifecycle';
    ({ pool, db } = setupTestPool());
  });
  afterAll(async () => {
    await cleanupTenants(pool, createdTenantIds);
    await pool.end();
    clearKmsStub();
    clearCloudTasksStub();
  });
  beforeEach(() => {
    withKmsStub();
    withCloudTasksStub();
  });
  afterEach(() => {
    clearKmsStub();
    clearCloudTasksStub();
  });

  it('happy path: ACTIVE tenant → 200 + grace_until + export_archive present', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);

    const storage = inMemoryStorage();
    const app = buildTestApp({ pool, testHooks: { storage } });
    const res = await app.request(`/v1/tenants/${id}/offboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grace_period_days: 30 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { id: string; status: string };
      grace_until: string | null;
      export_archive: { gcsUri: string; signedUrl: string } | undefined;
    };
    expect(body.tenant.id).toBe(id);
    expect(body.tenant.status).toBe('OFFBOARDING');
    expect(body.grace_until).not.toBeNull();
    expect(body.export_archive).toBeDefined();
    expect(body.export_archive?.gcsUri).toMatch(/^gs:\/\//);
    // Archive write went through the testHooks-injected storage (not live GCS).
    const archiveSave = storage.calls.find((c) => c.method === 'save');
    expect(archiveSave).toBeDefined();
  });
});

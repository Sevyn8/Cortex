/**
 * POST /v1/tenants/:id/force-terminate (super-admin).
 *
 * D.6 lands the happy-path test — D.4.5 deferred this pending the
 * route-level `testHooks.storage` seam. The cascade itself is still
 * library-layer (covered in
 * `packages/tenant-context/test/force-terminate.spec.ts`); this
 * spec covers the HTTP wrapper end-to-end with stubbed GCS.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  REJECTING_SUPER_ADMIN_GUARD,
  buildTestApp,
  cleanupTenants,
  clearKmsStub,
  inMemoryStorage,
  mintRunTag,
  seedActiveTenant,
  setupTestPool,
  withKmsStub,
} from './_helpers.js';

const RUN_TAG = mintRunTag('d6-force-terminate');

describe('POST /v1/tenants/:id/force-terminate', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    ({ pool, db } = setupTestPool());
  });
  afterAll(async () => {
    await cleanupTenants(pool, createdTenantIds);
    await pool.end();
    clearKmsStub();
  });
  beforeEach(() => withKmsStub());
  afterEach(() => clearKmsStub());

  it('missing reason → 400', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${randomUUID()}/force-terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('non-existent tenant → 404', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${randomUUID()}/force-terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'compliance escalation' }),
    });
    expect(res.status).toBe(404);
  });

  it('super-admin guard wiring: rejecting guard injection → 403', async () => {
    const app = buildTestApp({ pool, superAdminGuard: REJECTING_SUPER_ADMIN_GUARD });
    const res = await app.request(`/v1/tenants/${randomUUID()}/force-terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(res.status).toBe(403);
  });

  it('happy path: ACTIVE tenant + accepting guard + reason → 200 + tenant TERMINATED', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);

    const storage = inMemoryStorage();
    // Default super-admin guard is the no-op pass-through (Phase 1
    // SD8 — deny-by-default lives at Cloud Run invoker IAM, per
    // §7.7.4). force-terminate cascades through GCS via testHooks-
    // injected storage.
    const app = buildTestApp({ pool, testHooks: { storage } });
    const res = await app.request(`/v1/tenants/${id}/force-terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'D.6 force-terminate happy-path test' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(id);
    expect(body.status).toBe('TERMINATED');
    expect(storage.calls.find((c) => c.method === 'deleteFiles')).toBeDefined();
  });
});

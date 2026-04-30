/**
 * POST /v1/tenants/:id/force-terminate (super-admin).
 *
 * Same Storage-cascade caveat as terminate.spec.ts — happy path's
 * GCS-listFiles + delete chain is library-tested in
 * packages/tenant-context/test/force-terminate.spec.ts. This spec
 * covers the HTTP wrapper's error-mapping + the super-admin guard
 * wiring; the cascade itself is library-layer.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  REJECTING_SUPER_ADMIN_GUARD,
  buildTestApp,
  cleanupTenants,
  clearKmsStub,
  setupTestPool,
  withKmsStub,
} from './_helpers.js';

describe('POST /v1/tenants/:id/force-terminate', () => {
  let pool: Pool;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    ({ pool } = setupTestPool());
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
});

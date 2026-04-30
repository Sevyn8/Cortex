/**
 * GET /v1/tenants — list (super-admin scope).
 */
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

describe('GET /v1/tenants (list)', () => {
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

  it('happy path → 200 with { items, total, limit, offset }', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request('/v1/tenants?limit=5&offset=0', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; limit: number };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.limit).toBe(5);
  });

  it('limit > 200 → 400', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request('/v1/tenants?limit=999', { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('super-admin guard wiring: rejecting guard injection → 403', async () => {
    const app = buildTestApp({ pool, superAdminGuard: REJECTING_SUPER_ADMIN_GUARD });
    const res = await app.request('/v1/tenants', { method: 'GET' });
    expect(res.status).toBe(403);
  });
});

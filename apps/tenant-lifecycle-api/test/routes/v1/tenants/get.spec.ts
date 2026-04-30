/**
 * GET /v1/tenants/:id — read.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  buildTestApp,
  cleanupTenants,
  clearKmsStub,
  mintRunTag,
  seedActiveTenant,
  setupTestPool,
  withKmsStub,
} from './_helpers.js';

const RUN_TAG = mintRunTag('d3-get');

describe('GET /v1/tenants/:id', () => {
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

  it('happy path → 200 with the tenant row', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe(id);
  });

  it('non-existent uuid → 404', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${randomUUID()}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('invalid uuid in path → 400', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request('/v1/tenants/not-a-uuid', { method: 'GET' });
    expect(res.status).toBe(400);
  });
});

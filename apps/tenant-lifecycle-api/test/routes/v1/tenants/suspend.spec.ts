/**
 * POST /v1/tenants/:id/suspend.
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

const RUN_TAG = mintRunTag('d3-suspend');

describe('POST /v1/tenants/:id/suspend', () => {
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

  it('happy path → 200 with status=SUSPENDED', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/suspend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test suspend' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('SUSPENDED');
  });

  it('missing reason → 400', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-no-reason` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/suspend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('non-existent tenant → 404', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${randomUUID()}/suspend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(res.status).toBe(404);
  });
});

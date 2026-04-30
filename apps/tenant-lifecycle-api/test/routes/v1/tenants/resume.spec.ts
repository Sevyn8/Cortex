/**
 * POST /v1/tenants/:id/resume.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenants } from '@cortex/tenant-context';
import {
  ACTOR,
  buildTestApp,
  cleanupTenants,
  clearKmsStub,
  mintRunTag,
  seedActiveTenant,
  seedEnterpriseRequestedTenant,
  setupTestPool,
  withKmsStub,
} from './_helpers.js';

const RUN_TAG = mintRunTag('d3-resume');

describe('POST /v1/tenants/:id/resume', () => {
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

  it('happy path → 200 with status=ACTIVE', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);
    await tenants.suspend(db, id, 'pre-resume', { actor: ACTOR });

    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ACTIVE');
  });

  it('REQUESTED tenant → 409 (TenantStatusError)', async () => {
    const id = await seedEnterpriseRequestedTenant({ db, externalId: `${RUN_TAG}-requested` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it('non-existent tenant → 404', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${randomUUID()}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

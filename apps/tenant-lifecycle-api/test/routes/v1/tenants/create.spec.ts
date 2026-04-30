/**
 * POST /v1/tenants — create / provision.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  buildTestApp,
  cleanupTenants,
  clearCloudTasksStub,
  clearKmsStub,
  mintRunTag,
  setupTestPool,
  withCloudTasksStub,
  withKmsStub,
} from './_helpers.js';

const RUN_TAG = mintRunTag('d3-create');

describe('POST /v1/tenants (create / provision)', () => {
  let pool: Pool;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    ({ pool } = setupTestPool());
    withCloudTasksStub();
  });
  afterAll(async () => {
    await cleanupTenants(pool, createdTenantIds);
    await pool.end();
    clearKmsStub();
    clearCloudTasksStub();
  });
  beforeEach(() => withKmsStub());
  afterEach(() => clearKmsStub());

  it('happy path → 202 with { tenant_id, status }', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        external_id: `${RUN_TAG}-happy`,
        display_name: 'Create Happy',
        tier: 'STANDARD',
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { tenant_id?: string; status?: string };
    expect(body.tenant_id).toBeDefined();
    if (body.tenant_id !== undefined) createdTenantIds.push(body.tenant_id);
  });

  it('missing required field (external_id) → 400', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'No External', tier: 'STANDARD' }),
    });
    expect(res.status).toBe(400);
  });

  it('invalid tier → 400', async () => {
    const app = buildTestApp({ pool });
    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        external_id: `${RUN_TAG}-bad-tier`,
        display_name: 'Bad',
        tier: 'GOLDEN',
      }),
    });
    expect(res.status).toBe(400);
  });
});

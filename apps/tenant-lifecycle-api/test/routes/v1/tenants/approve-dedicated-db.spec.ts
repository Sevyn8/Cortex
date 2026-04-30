/**
 * POST /v1/tenants/:id/approve-dedicated-db (super-admin; Q-OPEN-6).
 *
 * Verifies tenants.approveDedicatedDb's HTTP wrapping:
 *   - happy: ENTERPRISE+REQUESTED → 200 + dedicated_db_approved=true
 *     + audit emits TENANT_DEDICATED_DB_APPROVED with the workspace
 *     before_state/after_state envelope + payload {approved_by, notes}.
 *   - 409: STANDARD or non-REQUESTED → TenantStatusError mapping.
 *   - 400: missing approved_by_user_id (zod schema rejection).
 *   - 403: super-admin guard wiring (rejecting injection).
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
  mintRunTag,
  seedActiveTenant,
  seedEnterpriseRequestedTenant,
  setupTestPool,
  withKmsStub,
} from './_helpers.js';
import { fetchAuditEvents } from '../../../../../../packages/tenant-context/test/helpers/audit.js';

const RUN_TAG = mintRunTag('d3-approve-ddb');

describe('POST /v1/tenants/:id/approve-dedicated-db', () => {
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

  it('happy path → 200 + dedicated_db_approved=true; emits TENANT_DEDICATED_DB_APPROVED', async () => {
    const id = await seedEnterpriseRequestedTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/approve-dedicated-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approved_by_user_id: 'cfo-1',
        notes: 'cost approved per ticket FIN-42',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dedicated_db_approved?: boolean };
    expect(body.dedicated_db_approved).toBe(true);

    const events = await fetchAuditEvents(db, id);
    const approved = events.find((e) => e.action === 'TENANT_DEDICATED_DB_APPROVED');
    expect(approved).toBeDefined();
    expect(approved?.payload).toMatchObject({
      before_state: { dedicated_db_approved: false },
      after_state: { dedicated_db_approved: true },
      approved_by_user_id: 'cfo-1',
      notes: 'cost approved per ticket FIN-42',
    });
  });

  it('STANDARD tenant → 409 (gate is meaningful only for ENTERPRISE-REQUESTED)', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-standard` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/approve-dedicated-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved_by_user_id: 'cfo' }),
    });
    expect(res.status).toBe(409);
  });

  it('missing approved_by_user_id → 400', async () => {
    const id = await seedEnterpriseRequestedTenant({ db, externalId: `${RUN_TAG}-no-user` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/approve-dedicated-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'no user' }),
    });
    expect(res.status).toBe(400);
  });

  it('super-admin guard wiring: rejecting guard injection → 403', async () => {
    const app = buildTestApp({ pool, superAdminGuard: REJECTING_SUPER_ADMIN_GUARD });
    const res = await app.request(`/v1/tenants/${randomUUID()}/approve-dedicated-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved_by_user_id: 'cfo' }),
    });
    expect(res.status).toBe(403);
  });
});

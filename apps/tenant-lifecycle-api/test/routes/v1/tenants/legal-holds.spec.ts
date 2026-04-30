/**
 * POST /v1/tenants/:id/legal-holds (set) +
 * DELETE /v1/tenants/:id/legal-holds/:hold_id (release; idempotent 204).
 *
 * Set + release share the legal_hold table fixture; one spec covers
 * both (alternative would be 2 files with duplicated setup).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { legalHolds } from '@cortex/tenant-context';
import {
  ACTOR,
  buildTestApp,
  cleanupTenants,
  clearKmsStub,
  mintRunTag,
  seedActiveTenant,
  setupTestPool,
  withKmsStub,
} from './_helpers.js';

const RUN_TAG = mintRunTag('d3-legal-holds');

describe('legal-holds — set + release', () => {
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

  describe('POST /v1/tenants/:id/legal-holds (set)', () => {
    it('happy path scope=tenant → 201 with hold row', async () => {
      const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-set-happy` });
      createdTenantIds.push(id);
      const app = buildTestApp({ pool });
      const res = await app.request(`/v1/tenants/${id}/legal-holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'tenant',
          reason: 'litigation',
          set_by_user_id: 'legal-team-1',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { tenant_id?: string };
      expect(body.tenant_id).toBe(id);
    });

    it('missing scope → 400', async () => {
      const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-set-bad` });
      createdTenantIds.push(id);
      const app = buildTestApp({ pool });
      const res = await app.request(`/v1/tenants/${id}/legal-holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'no scope' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /v1/tenants/:id/legal-holds/:hold_id (release)', () => {
    it('happy path → 204 (no content)', async () => {
      const tenantId = await seedActiveTenant({ db, externalId: `${RUN_TAG}-release-happy` });
      createdTenantIds.push(tenantId);
      const hold = await legalHolds.set(
        db,
        tenantId,
        { scope: 'tenant', reason: 'temp', setByUserId: 'legal' },
        { actor: ACTOR },
      );
      const app = buildTestApp({ pool });
      const res = await app.request(`/v1/tenants/${tenantId}/legal-holds/${hold.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ released_by_user_id: 'legal' }),
      });
      expect(res.status).toBe(204);
    });

    it('invalid hold_id uuid → 400', async () => {
      const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-release-bad-uuid` });
      createdTenantIds.push(id);
      const app = buildTestApp({ pool });
      const res = await app.request(`/v1/tenants/${id}/legal-holds/not-a-uuid`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ released_by_user_id: 'legal' }),
      });
      expect(res.status).toBe(400);
    });
  });
});

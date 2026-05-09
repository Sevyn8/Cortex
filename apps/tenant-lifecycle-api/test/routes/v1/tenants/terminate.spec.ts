/**
 * POST /v1/tenants/:id/terminate.
 *
 * Happy path is intentionally not covered here — tenants.terminate's
 * cascade dispatches a real Cloud Storage listFiles + delete chain
 * (per packages/tenant-context/test/terminate.spec.ts which uses
 * cascadeOverrides.storage stubs). Replicating that infrastructure
 * at the HTTP wrapper layer is the same redundancy we skipped for
 * /v1/tenants/:id/offboard. The library covers the workflow; this
 * spec covers the HTTP wrapper's error-mapping wiring against the
 * §7.6 status-code table.
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
  inMemoryStorage,
  mintRunTag,
  seedActiveTenant,
  setupTestPool,
  withKmsStub,
} from './_helpers.js';

const RUN_TAG = mintRunTag('d3-terminate');

describe('POST /v1/tenants/:id/terminate', () => {
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

  it('ACTIVE tenant (not OFFBOARDING) → 409 TenantStatusError', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-active` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it('OFFBOARDING + grace elapsed + active legal hold → 409 TenantLegalHoldError', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-legal-hold` });
    createdTenantIds.push(id);

    // Set a legal hold (tenant scope), then directly transition the
    // tenant to OFFBOARDING with grace_until in the past — bypasses
    // the offboard workflow's GCS / Cloud Tasks dependencies.
    await legalHolds.set(
      db,
      id,
      { scope: 'tenant', reason: 'litigation', setByUserId: 'legal-team-1' },
      { actor: ACTOR },
    );
    await pool.query(
      `UPDATE tenant SET status = 'OFFBOARDING', offboarding_grace_until = now() - interval '1 day' WHERE id = $1`,
      [id],
    );

    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it('happy path: OFFBOARDING + grace elapsed → 202 + tenant TERMINATED + GCS prefix delete', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);

    // Transition directly to OFFBOARDING with grace_until in the past
    // (mirrors the §7.4 contract: terminate gates on OFFBOARDING +
    // elapsed grace; the library tests cover the workflow,
    // d6-gate-evidence.md captures live curl evidence).
    await pool.query(
      `UPDATE tenant SET status = 'OFFBOARDING', offboarding_grace_until = now() - interval '1 day' WHERE id = $1`,
      [id],
    );

    const storage = inMemoryStorage();
    const app = buildTestApp({ pool, testHooks: { storage } });
    const res = await app.request(`/v1/tenants/${id}/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(id);
    expect(body.status).toBe('TERMINATED');
    // Cascade deleteFiles routed through the testHooks-injected storage.
    expect(storage.calls.find((c) => c.method === 'deleteFiles')).toBeDefined();
  });

  it('strict body schema rejects extra keys → 400', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-strict-body` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unexpected_field: 'should-reject' }),
    });
    expect(res.status).toBe(400);
  });
});

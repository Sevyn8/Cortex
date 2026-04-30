/**
 * POST /v1/tenants/:id/rotate-keys (HTTP on-demand path).
 *
 * §7.6 load-bearing distinction: HTTP path uses the caller actor
 * (`cortex-tenant-lifecycle-api`), NOT the worker's hardcoded
 * `cortex-tenant-lifecycle-worker`. Forensic queries filter on
 * `actor_id` to disambiguate operator-initiated vs scheduled rotations.
 */
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
  setupTestPool,
  withKmsStub,
} from './_helpers.js';
import { fetchAuditEvents } from '../../../../../../packages/tenant-context/test/helpers/audit.js';

const RUN_TAG = mintRunTag('d3-rotate');

describe('POST /v1/tenants/:id/rotate-keys', () => {
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

  it('happy path → 200; HTTP-path actor distinct from worker actor in audit chain', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-happy` });
    createdTenantIds.push(id);
    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/rotate-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { last_key_rotated_at?: string | null };
    expect(body.last_key_rotated_at).not.toBeNull();

    // §7.6 actor distinction: HTTP path = cortex-tenant-lifecycle-api,
    // worker path = cortex-tenant-lifecycle-worker. The audit chain
    // is the source of truth for "operator-initiated vs scheduled".
    const events = await fetchAuditEvents(db, id);
    const rotated = events.find((e) => e.action === 'TENANT_KEY_ROTATED');
    expect(rotated?.actor_id).toBe('cortex-tenant-lifecycle-api');
    expect(rotated?.actor_id).not.toBe('cortex-tenant-lifecycle-worker');
  });

  it('SUSPENDED tenant → 409', async () => {
    const id = await seedActiveTenant({ db, externalId: `${RUN_TAG}-suspended` });
    createdTenantIds.push(id);
    await tenants.suspend(db, id, 'pre-rotate', { actor: ACTOR });

    const app = buildTestApp({ pool });
    const res = await app.request(`/v1/tenants/${id}/rotate-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });
});

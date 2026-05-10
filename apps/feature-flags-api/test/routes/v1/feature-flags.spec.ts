/**
 * P1.6 Slice B — `GET /v1/feature-flags` route integration tests.
 *
 * Tests run against real F04 substrate via `@cortex/test-db-harness`
 * pattern (matches Slice A's eval.spec.ts pattern). Hono's
 * `app.request(...)` API drives the route without spinning a real
 * HTTP server — same pattern as `tenant-lifecycle-api`'s route tests.
 *
 * Surface covered:
 *   1. Bulk fetch returns the 4 initial flags (boolean / variant /
 *      percentage) for a default-only tenant (consumer defaults
 *      visible without DB rows).
 *   2. Tenant-context binding via `x-cortex-tenant-id` header.
 *   3. `userId` query param flows through to percentage rollout.
 *   4. Missing tenant header → 400 problem-details.
 *   5. Multi-tenant isolation — tenant A's flags don't leak.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { resetConsumerRegistry, resetSchemaRegistry } from '@cortex/config-plane';
import {
  registerInitialFeatureFlags,
  flagsCacheClear,
  FEATURE_FLAGS_NAMESPACE,
  type FeatureFlagsNamespace,
} from '@cortex/feature-flags';

import { buildApp } from '../../../src/app.js';

function makePostgresPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) throw new Error('PGPASSWORD not set');
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: 'postgres',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

function makeTestUserPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) throw new Error('PGPASSWORD not set');
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'test_user',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

async function insertFlags(
  pool: Pool,
  tenantId: string,
  literalNamespace: string,
  flags: FeatureFlagsNamespace,
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_config_version
      (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
     VALUES ($1, $2, 1, NULL, 1, $3::jsonb)`,
    [tenantId, literalNamespace, JSON.stringify(flags)],
  );
}

async function cleanupTenant(pool: Pool, tenantId: string): Promise<void> {
  await pool
    .query(`DELETE FROM audit_event WHERE tenant_id = $1`, [tenantId])
    .catch(() => undefined);
  await pool.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [tenantId]);
}

describe('@cortex/feature-flags-api GET /v1/feature-flags (Slice B)', () => {
  let pgPool: Pool;
  let testPool: Pool;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    pgPool = makePostgresPool();
    testPool = makeTestUserPool();

    const a = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('p1-6-feature-flags-api-test-a', 'P1.6 Feature Flags API Test A', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    tenantId = a.rows[0]!.id;

    const b = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('p1-6-feature-flags-api-test-b', 'P1.6 Feature Flags API Test B', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    otherTenantId = b.rows[0]!.id;
  });

  afterAll(async () => {
    await cleanupTenant(pgPool, tenantId);
    await cleanupTenant(pgPool, otherTenantId);
    await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [otherTenantId]);
    await pgPool.end();
    await testPool.end();
  });

  beforeEach(() => {
    resetSchemaRegistry();
    resetConsumerRegistry();
    flagsCacheClear();
    // Re-register the 4 initial flags after the reset wiped them.
    registerInitialFeatureFlags();
  });

  afterEach(async () => {
    await cleanupTenant(pgPool, tenantId);
    await cleanupTenant(pgPool, otherTenantId);
  });

  it('returns the 4 initial flags for a default-only tenant', async () => {
    const app = buildApp({ pool: testPool });
    const res = await app.request('/v1/feature-flags', {
      headers: { 'x-cortex-tenant-id': tenantId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, { type: string; value: unknown }> };
    expect(body.flags).toBeDefined();
    expect(Object.keys(body.flags)).toHaveLength(4);
    expect(body.flags['admin-console.display-data-workspace-switcher']).toBeDefined();
    expect(body.flags['analytical.cx-dd-01-beta']).toBeDefined();
    expect(body.flags['agents.planogram.v2-model']).toBeDefined();
    expect(body.flags['ingestion.csv-agent-v2']).toBeDefined();
  });

  it('returns the correct types and default values for each flag type', async () => {
    const app = buildApp({ pool: testPool });
    const res = await app.request('/v1/feature-flags', {
      headers: { 'x-cortex-tenant-id': tenantId },
    });
    const body = (await res.json()) as { flags: Record<string, { type: string; value: unknown }> };
    expect(body.flags['admin-console.display-data-workspace-switcher']).toEqual({
      type: 'percentage',
      value: false, // default false; rollout 0% → all anonymous get default
    });
    expect(body.flags['analytical.cx-dd-01-beta']).toEqual({
      type: 'boolean',
      value: false,
    });
    expect(body.flags['agents.planogram.v2-model']).toEqual({
      type: 'variant',
      value: 'v1',
    });
    expect(body.flags['ingestion.csv-agent-v2']).toEqual({
      type: 'variant',
      value: 'v1',
    });
  });

  it('returns 400 problem-details when x-cortex-tenant-id header is missing', async () => {
    const app = buildApp({ pool: testPool });
    const res = await app.request('/v1/feature-flags');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; status?: number };
    expect(body.code).toBe('TENANT_CONTEXT_MISSING');
  });

  it('respects userId query param for percentage flag rollout', async () => {
    const app = buildApp({ pool: testPool });
    // Without userId — percentage flag returns default (false).
    const r1 = await app.request('/v1/feature-flags', {
      headers: { 'x-cortex-tenant-id': tenantId },
    });
    const b1 = (await r1.json()) as { flags: Record<string, { value: unknown }> };
    expect(b1.flags['admin-console.display-data-workspace-switcher']!.value).toBe(false);

    // With userId — bucket is computed; rollout is 0% so always default.
    const r2 = await app.request('/v1/feature-flags?userId=test-user-1', {
      headers: { 'x-cortex-tenant-id': tenantId },
    });
    const b2 = (await r2.json()) as { flags: Record<string, { value: unknown }> };
    expect(b2.flags['admin-console.display-data-workspace-switcher']!.value).toBe(false);
  });

  it('tenant override (DB row) wins over consumer default', async () => {
    // Override analytical.cx-dd-01-beta to true for tenant A only.
    await insertFlags(pgPool, tenantId, `tenant.${FEATURE_FLAGS_NAMESPACE}`, {
      'analytical.cx-dd-01-beta': {
        type: 'boolean',
        description: 'override',
        default: true,
      },
    });

    const app = buildApp({ pool: testPool });
    const res = await app.request('/v1/feature-flags', {
      headers: { 'x-cortex-tenant-id': tenantId },
    });
    const body = (await res.json()) as { flags: Record<string, { value: unknown }> };
    expect(body.flags['analytical.cx-dd-01-beta']!.value).toBe(true);
  });

  it("multi-tenant isolation — tenant A's override doesn't leak to tenant B", async () => {
    // Override flag for tenant A.
    await insertFlags(pgPool, tenantId, `tenant.${FEATURE_FLAGS_NAMESPACE}`, {
      'analytical.cx-dd-01-beta': {
        type: 'boolean',
        description: 'A only',
        default: true,
      },
    });

    const app = buildApp({ pool: testPool });
    const ra = await app.request('/v1/feature-flags', {
      headers: { 'x-cortex-tenant-id': tenantId },
    });
    const ba = (await ra.json()) as { flags: Record<string, { value: unknown }> };
    expect(ba.flags['analytical.cx-dd-01-beta']!.value).toBe(true);

    flagsCacheClear(); // ensure tenant B reads fresh
    const rb = await app.request('/v1/feature-flags', {
      headers: { 'x-cortex-tenant-id': otherTenantId },
    });
    const bb = (await rb.json()) as { flags: Record<string, { value: unknown }> };
    expect(bb.flags['analytical.cx-dd-01-beta']!.value).toBe(false); // consumer default
  });

  it('GET /health succeeds without tenant context', async () => {
    const app = buildApp({ pool: testPool });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});

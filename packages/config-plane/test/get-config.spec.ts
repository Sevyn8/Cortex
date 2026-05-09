/**
 * Integration tests for `getConfig` per F04 Slice A acceptance.
 *
 * Pattern mirrors `services/foundation/test/audit-chain.spec.ts`:
 * `getPool` from `@cortex/test-db-harness`, real Postgres, RLS-aware
 * via `withTenantContext` from `@cortex/canonical-schema/rls-test`.
 * Tests run as `test_user` (NOSUPERUSER NOBYPASSRLS) so RLS policies
 * apply — every query touching `tenant_config_version` happens inside
 * a tenant-bound transaction that satisfies the policy's
 * `tenant_id = cortex.current_tenant_id()` check.
 *
 * Tenant-row creation runs as the postgres user (table `tenant` is
 * NO-RLS per migration 0007 — control-plane registry that maps
 * app.tenant_id; bootstrapping it via RLS would be circular).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { z, ZodError } from 'zod';
import { withTenantContext } from '@cortex/canonical-schema/rls-test';
import { getConfig, NamespaceSchemaNotRegisteredError } from '../src/get-config.js';
import { registerNamespaceSchema, resetSchemaRegistry } from '../src/schema-registry.js';

const ThemeSchemaV1 = z.object({
  primary_color: z.string(),
  secondary_color: z.string(),
});
type ThemeV1 = z.infer<typeof ThemeSchemaV1>;

// Tenant-row management runs as postgres (table is NO-RLS but
// test_user lacks INSERT grant on `tenant`). Build a dedicated
// postgres-user pool for setup/teardown.
function makePostgresPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error('PGPASSWORD not set; required for getConfig spec setup.');
  }
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: 'postgres',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

// Pool for tenant-context-bound RLS-aware queries (test_user).
function makeTestUserPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error('PGPASSWORD not set; required for getConfig spec.');
  }
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'test_user',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

describe('@cortex/config-plane getConfig (Slice A read API)', () => {
  let pgPool: Pool;
  let testPool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pgPool = makePostgresPool();
    testPool = makeTestUserPool();
    const r = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('f04-slice-a-getconfig-test', 'F04 Slice A getConfig Test', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    tenantId = r.rows[0]!.id;
  });

  afterAll(async () => {
    await pgPool.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [tenantId]);
    await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    await pgPool.end();
    await testPool.end();
  });

  beforeEach(() => {
    resetSchemaRegistry();
  });

  afterEach(async () => {
    await pgPool.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [tenantId]);
  });

  it('returns null when no row matches (tenant_id, namespace)', async () => {
    registerNamespaceSchema('platform.theme', ThemeSchemaV1, { version: 1 });
    const result = await withTenantContext(testPool, tenantId, async (tx) =>
      getConfig<ThemeV1>(tx, tenantId, 'platform.theme'),
    );
    expect(result).toBeNull();
  });

  it('returns the validated parsed JSON when a row matches and a schema is registered', async () => {
    registerNamespaceSchema('platform.theme', ThemeSchemaV1, { version: 1 });
    const result = await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO tenant_config_version
          (tenant_id, namespace, version_number, config_json, schema_version)
         VALUES ($1, $2, 1, $3::jsonb, 1)`,
        [
          tenantId,
          'platform.theme',
          JSON.stringify({ primary_color: '#FF0000', secondary_color: '#00FF00' }),
        ],
      );
      return getConfig<ThemeV1>(tx, tenantId, 'platform.theme');
    });
    expect(result).not.toBeNull();
    expect(result!.primary_color).toBe('#FF0000');
    expect(result!.secondary_color).toBe('#00FF00');
  });

  it('throws NamespaceSchemaNotRegisteredError when row exists but no schema is registered', async () => {
    // Note: do NOT registerNamespaceSchema here.
    await expect(
      withTenantContext(testPool, tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO tenant_config_version
            (tenant_id, namespace, version_number, config_json, schema_version)
           VALUES ($1, $2, 1, $3::jsonb, 1)`,
          [
            tenantId,
            'platform.theme',
            JSON.stringify({ primary_color: '#FF0000', secondary_color: '#00FF00' }),
          ],
        );
        return getConfig(tx, tenantId, 'platform.theme');
      }),
    ).rejects.toThrow(NamespaceSchemaNotRegisteredError);
  });

  it("throws ZodError when the row's config_json fails schema validation", async () => {
    registerNamespaceSchema('platform.theme', ThemeSchemaV1, { version: 1 });
    await expect(
      withTenantContext(testPool, tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO tenant_config_version
            (tenant_id, namespace, version_number, config_json, schema_version)
           VALUES ($1, $2, 1, $3::jsonb, 1)`,
          [
            tenantId,
            'platform.theme',
            JSON.stringify({ primary_color: 12345, secondary_color: '#00FF00' }),
          ],
        );
        return getConfig(tx, tenantId, 'platform.theme');
      }),
    ).rejects.toThrow(ZodError);
  });

  it('returns the highest version_number row when multiple versions exist for (tenant, namespace)', async () => {
    registerNamespaceSchema('platform.theme', ThemeSchemaV1, { version: 1 });
    const result = await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO tenant_config_version
          (tenant_id, namespace, version_number, config_json, schema_version)
         VALUES
           ($1, $2, 1, $3::jsonb, 1),
           ($1, $2, 2, $4::jsonb, 1),
           ($1, $2, 3, $5::jsonb, 1)`,
        [
          tenantId,
          'platform.theme',
          JSON.stringify({ primary_color: '#001', secondary_color: '#002' }),
          JSON.stringify({ primary_color: '#011', secondary_color: '#012' }),
          JSON.stringify({ primary_color: '#0FF', secondary_color: '#FF0' }),
        ],
      );
      return getConfig<ThemeV1>(tx, tenantId, 'platform.theme');
    });
    expect(result!.primary_color).toBe('#0FF');
    expect(result!.secondary_color).toBe('#FF0');
  });

  it("looks up schema by the row's pinned schema_version (not the latest registered)", async () => {
    // Register v=1 with the canonical shape; register v=2 with a different shape.
    registerNamespaceSchema('platform.theme', ThemeSchemaV1, { version: 1 });
    const ThemeSchemaV2 = z.object({
      // V2 renames primary_color → main_color (intentionally different).
      main_color: z.string(),
      secondary_color: z.string(),
    });
    registerNamespaceSchema('platform.theme', ThemeSchemaV2, { version: 2 });

    // Insert a row pinned to schema_version=1 with the V1 shape.
    const result = await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO tenant_config_version
          (tenant_id, namespace, version_number, config_json, schema_version)
         VALUES ($1, $2, 1, $3::jsonb, 1)`,
        [
          tenantId,
          'platform.theme',
          JSON.stringify({ primary_color: '#FF0000', secondary_color: '#00FF00' }),
        ],
      );
      return getConfig<ThemeV1>(tx, tenantId, 'platform.theme');
    });
    // Should validate against V1 (the row's pinned version), NOT V2.
    expect(result!.primary_color).toBe('#FF0000');
  });
});

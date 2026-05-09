/**
 * Tests for `getQuotaConfig` — F02 Slice A swap (sub-phase 5.3).
 *
 * Pre-swap (Phase 1) the function was sync + DB-free; tests asserted
 * on the per-tier defaults. Post-swap the function is async and may
 * consult `tenant_config_version` for a per-tenant override when ctx
 * supplies tenantId + db. Two test groups:
 *
 *   - per-tier lookup (no ctx) — exercises the fallback path; runs
 *     without DB. Same coverage as pre-swap, with `await`.
 *   - per-tenant override (with ctx) — DB-dependent; seeds
 *     `tenant_config_version` rows and asserts the override path.
 *
 * Per planning-doc D7 + sub-phase 5.3 contract: override values in
 * `config_json.quotas[resource_class]` come back from jsonb as
 * `number` (JSON has no native bigint). The resolver coerces to
 * `bigint` via `BigInt(...)`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  DEFAULT_TIER_QUOTAS,
  RESOURCE_CLASSES,
  getQuotaConfig,
  type QuotaTier,
  type ResourceClass,
} from '../src/index.js';

const TIERS: readonly QuotaTier[] = ['STANDARD', 'ENTERPRISE'];

// ───────────────────────────────────────────────────────────────────
// Per-tier lookup (no ctx) — DB-independent
// ───────────────────────────────────────────────────────────────────

describe('getQuotaConfig — per-tier lookup (no ctx, fallback path)', () => {
  it('STANDARD returns DEFAULT_TIER_QUOTAS.STANDARD values for each resource class', async () => {
    for (const cls of RESOURCE_CLASSES) {
      expect(await getQuotaConfig('STANDARD', cls)).toBe(DEFAULT_TIER_QUOTAS.STANDARD[cls]);
    }
  });

  it('ENTERPRISE returns DEFAULT_TIER_QUOTAS.ENTERPRISE values for each resource class', async () => {
    for (const cls of RESOURCE_CLASSES) {
      expect(await getQuotaConfig('ENTERPRISE', cls)).toBe(DEFAULT_TIER_QUOTAS.ENTERPRISE[cls]);
    }
  });

  it('return type is bigint (not number, not string) for every (tier, class) pair', async () => {
    for (const tier of TIERS) {
      for (const cls of RESOURCE_CLASSES) {
        const value = await getQuotaConfig(tier, cls);
        expect(typeof value).toBe('bigint');
      }
    }
  });

  it('ctx with only tenantId (no db) falls through to tier default', async () => {
    const value = await getQuotaConfig('STANDARD', 'api_calls_per_minute', {
      tenantId: randomUUID(),
    });
    expect(value).toBe(DEFAULT_TIER_QUOTAS.STANDARD.api_calls_per_minute);
  });
});

describe('getQuotaConfig vs DEFAULT_TIER_QUOTAS — table consistency', () => {
  it('every (tier, class) lookup matches the table verbatim — F02 fallback regression guard', async () => {
    // Slice A swapped getQuotaConfig to consult tenant_config_version
    // with fallback to DEFAULT_TIER_QUOTAS. This test ensures the
    // fallback values stay aligned with the table — drift means the
    // F02 swap accidentally changed fallback semantics. Decision 7's
    // "defaults are a floor, not a target" framing must hold.
    for (const tier of TIERS) {
      for (const cls of RESOURCE_CLASSES) {
        expect(await getQuotaConfig(tier, cls)).toBe(DEFAULT_TIER_QUOTAS[tier][cls]);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────
// Per-tenant override (with ctx) — DB-dependent
// ───────────────────────────────────────────────────────────────────

describe('getQuotaConfig — per-tenant override (ctx supplies tenantId + db)', () => {
  let pool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  const seededTenantIds: string[] = [];

  beforeAll(() => {
    pool = new Pool({
      host: process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.PGPORT ?? 5433),
      user: process.env.PGUSER ?? 'test_user',
      password: process.env.PGPASSWORD ?? 'testpw',
      database: process.env.PGDATABASE ?? 'cortex',
    });
    db = drizzle(pool);
  });

  afterAll(async () => {
    for (const id of seededTenantIds) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        await client.query('DELETE FROM tenant_config_version WHERE tenant_id = $1', [id]);
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
      } finally {
        client.release();
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
  });

  /**
   * Seed a tenant + tenant_config_version v=1 with the supplied
   * config_json payload. RLS bind required for the
   * tenant_config_version INSERT (FOR ALL policy from migration 0007).
   */
  async function seedTenantConfig(
    label: string,
    configJson: Record<string, unknown>,
  ): Promise<string> {
    const tenantId = randomUUID();
    await pool.query(
      `INSERT INTO tenant (id, external_id, display_name, tier) VALUES ($1, $2, 'Test', 'STANDARD')`,
      [tenantId, `test-quota-${label}-${tenantId.slice(0, 8)}`],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await client.query(
        // namespace='tenant' per F04 D1 reshape (migration 0014); F02
        // provisioning seeds v=1 in this namespace.
        `INSERT INTO tenant_config_version (tenant_id, namespace, version_number, config_json)
         VALUES ($1, 'tenant', $2, $3::jsonb)`,
        [tenantId, 1, JSON.stringify(configJson)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    seededTenantIds.push(tenantId);
    return tenantId;
  }

  /**
   * Run getQuotaConfig with ctx, binding `app.tenant_id` per the
   * production caller contract.
   */
  async function lookupBound(
    tenantId: string,
    tier: QuotaTier,
    resourceClass: ResourceClass,
  ): Promise<bigint> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return getQuotaConfig(tier, resourceClass, { tenantId, db: tx });
    });
  }

  it('returns the per-tenant override value when present in config_json.quotas', async () => {
    const tenantId = await seedTenantConfig('override-present', {
      quotas: { api_calls_per_minute: 1500 },
    });
    const value = await lookupBound(tenantId, 'STANDARD', 'api_calls_per_minute');
    expect(value).toBe(1500n);
  });

  it('coerces JSON number override to bigint (jsonb has no native bigint)', async () => {
    const tenantId = await seedTenantConfig('coerce', {
      quotas: { db_connections: 50 },
    });
    const value = await lookupBound(tenantId, 'STANDARD', 'db_connections');
    expect(typeof value).toBe('bigint');
    expect(value).toBe(50n);
  });

  it('falls back to tier default when tenant has no config_version row', async () => {
    const ghostTenantId = randomUUID();
    const value = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${ghostTenantId}, true)`);
      return getQuotaConfig('STANDARD', 'api_calls_per_minute', {
        tenantId: ghostTenantId,
        db: tx,
      });
    });
    expect(value).toBe(DEFAULT_TIER_QUOTAS.STANDARD.api_calls_per_minute);
  });

  it('falls back to tier default when config_json.quotas is absent (no quotas key)', async () => {
    const tenantId = await seedTenantConfig('no-quotas-key', {
      // No `quotas` field — simulates initialConfig that doesn't override quotas.
      featureFlags: { something: true },
    });
    const value = await lookupBound(tenantId, 'STANDARD', 'api_calls_per_minute');
    expect(value).toBe(DEFAULT_TIER_QUOTAS.STANDARD.api_calls_per_minute);
  });

  it('falls back to tier default when this resource class is not in the override (partial override)', async () => {
    const tenantId = await seedTenantConfig('partial', {
      quotas: { api_calls_per_minute: 999 }, // override only this class
    });
    expect(await lookupBound(tenantId, 'STANDARD', 'api_calls_per_minute')).toBe(999n);
    expect(await lookupBound(tenantId, 'STANDARD', 'db_connections')).toBe(
      DEFAULT_TIER_QUOTAS.STANDARD.db_connections,
    );
  });

  it('latest version_number wins (desc order applied)', async () => {
    const tenantId = await seedTenantConfig('versioned', {
      quotas: { api_calls_per_minute: 100 },
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await client.query(
        // namespace='tenant' per F04 D1 reshape (migration 0014).
        `INSERT INTO tenant_config_version (tenant_id, namespace, version_number, config_json)
         VALUES ($1, 'tenant', $2, $3::jsonb)`,
        [tenantId, 2, JSON.stringify({ quotas: { api_calls_per_minute: 200 } })],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const value = await lookupBound(tenantId, 'STANDARD', 'api_calls_per_minute');
    expect(value).toBe(200n);
  });
});

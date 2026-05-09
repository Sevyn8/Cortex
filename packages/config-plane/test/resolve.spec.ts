/**
 * F04 Slice C — `resolveConfig` + cache + consumer-registry +
 * lifecycle invalidation integration tests.
 *
 * Surfaces covered:
 *   1. Resolver layering — `tenant.<ns>` → `platform.<ns>` →
 *      registered default → null. Multi-tenant isolation.
 *   2. Cache behavior — hits, miss-then-populate, hit-with-null
 *      vs miss-undefined, TTL expiry, custom TTL, FIFO eviction at
 *      size cap.
 *   3. Active invalidation — promoteDraft + rollbackVersion
 *      invalidate the resolver cache POST-commit; pessimistic
 *      invalidation across both `tenant.` and `platform.` tier
 *      writes; failed lifecycle attempts (validation / genesis)
 *      do NOT invalidate cache.
 *   4. Dual-namespace schema registration — registerConfigConsumer
 *      registers the same schema under both literal namespaces.
 *   5. Schema-version pinning — rows pinned to v=N validate
 *      against schema registered at v=N regardless of which tier.
 *
 * Tests run as `test_user` (NOSUPERUSER NOBYPASSRLS); helpers bind
 * tenant context for RLS-aware reads. Tenant + raw config-version
 * INSERTs run via postgres pool (control-plane registry; bypasses
 * the lifecycle to seed specific tier states).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTenantContext } from '@cortex/canonical-schema/rls-test';
import {
  resolveConfig,
  registerConfigConsumer,
  resetConsumerRegistry,
  DEFAULT_CONSUMER_TTL_SECONDS,
  cacheGet,
  cacheSet,
  cacheClear,
  cacheSize,
  setCacheMaxEntries,
  registerNamespaceSchema,
  resetSchemaRegistry,
  getNamespaceSchema,
  createDraft,
  promoteDraft,
  rollbackVersion,
  RollbackAtGenesisError,
  PromoteValidationError,
  type Actor,
} from '../src/index.js';
import { cleanupConfigPlaneState } from './_utils/cleanup.js';

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

const ThemeSchema = z.object({
  primary_color: z.string(),
  secondary_color: z.string(),
});
type Theme = z.infer<typeof ThemeSchema>;

const tenantTheme: Theme = { primary_color: '#TENANT', secondary_color: '#tenant' };
const platformTheme: Theme = { primary_color: '#PLATFORM', secondary_color: '#platform' };
const defaultTheme: Theme = { primary_color: '#DEFAULT', secondary_color: '#default' };

const userActor: Actor = {
  type: 'user',
  id: randomUUID(),
  description: 'F04 Slice C resolver test user',
};

async function insertVersion(
  pool: Pool,
  tenantId: string,
  literalNamespace: string,
  config: Record<string, unknown>,
  versionNumber = 1,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tenant_config_version
      (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
     VALUES ($1, $2, $3, NULL, 1, $4::jsonb)
     RETURNING id`,
    [tenantId, literalNamespace, versionNumber, JSON.stringify(config)],
  );
  return r.rows[0]!.id;
}

describe('@cortex/config-plane resolveConfig + cache + consumer-registry (Slice C)', () => {
  let pgPool: Pool;
  let testPool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    pgPool = makePostgresPool();
    testPool = makeTestUserPool();
    db = drizzle(testPool);

    const a = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('f04-slice-c-resolve-test-a', 'F04 Slice C Resolve Test A', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    tenantId = a.rows[0]!.id;

    const b = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('f04-slice-c-resolve-test-b', 'F04 Slice C Resolve Test B', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    otherTenantId = b.rows[0]!.id;
  });

  afterAll(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
    await cleanupConfigPlaneState(pgPool, otherTenantId);
    await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [otherTenantId]);
    await pgPool.end();
    await testPool.end();
  });

  beforeEach(() => {
    // Module-level registries persist across tests; reset in
    // beforeEach so each test sees a clean slate.
    resetSchemaRegistry();
    resetConsumerRegistry();
    cacheClear();
    setCacheMaxEntries(1000);
  });

  afterEach(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
    await cleanupConfigPlaneState(pgPool, otherTenantId);
  });

  // ────────────────────────────────────────────────────────────────
  // Resolver layering (3-tier walk)
  // ────────────────────────────────────────────────────────────────

  describe('resolver layering — tenant → platform → default', () => {
    it('tenant tier wins when tenant.<ns> row exists alongside platform.<ns> + default', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme);
      await insertVersion(pgPool, tenantId, 'platform.theme', platformTheme);

      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toEqual(tenantTheme);
    });

    it('platform tier wins when tenant.<ns> is absent and platform.<ns> + default exist', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      await insertVersion(pgPool, tenantId, 'platform.theme', platformTheme);

      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toEqual(platformTheme);
    });

    it('falls through to registered default when both DB tiers are empty', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });

      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toEqual(defaultTheme);
    });

    it('returns null when all three tiers are empty (no consumer registered)', async () => {
      // Need to register schemas (the literal-namespace path of getConfig
      // throws if no schema registered for a row's pinned version) — but
      // since no DB rows exist, no schema lookup happens; resolver falls
      // straight through to "no consumer → null".
      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toBeNull();
    });

    it("multi-tenant isolation — tenant A's tenant-tier row doesn't leak to tenant B's resolve", async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme);

      const a = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      const b = await withTenantContext(testPool, otherTenantId, (tx) =>
        resolveConfig<Theme>(tx, otherTenantId, 'theme'),
      );
      expect(a).toEqual(tenantTheme);
      expect(b).toEqual(defaultTheme);
    });

    it('consumer with explicit defaultValue=null caches null on tier miss', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: null,
      });
      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toBeNull();
      // Cached null distinguishes from miss-undefined.
      const cached = cacheGet<Theme>(tenantId, 'theme');
      expect(cached).toEqual({ value: null });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Cache behavior
  // ────────────────────────────────────────────────────────────────

  describe('cache primitives', () => {
    it('cacheGet returns undefined for miss, distinct from {value:null} hit', () => {
      expect(cacheGet(tenantId, 'theme')).toBeUndefined();
      cacheSet(tenantId, 'theme', null, 60);
      expect(cacheGet(tenantId, 'theme')).toEqual({ value: null });
    });

    it('cacheSet+Get round-trips a non-null value', () => {
      cacheSet(tenantId, 'theme', tenantTheme, 60);
      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({ value: tenantTheme });
    });

    it('cacheGet returns undefined after TTL expires', async () => {
      cacheSet(tenantId, 'theme', tenantTheme, 0.05); // 50ms
      expect(cacheGet(tenantId, 'theme')).toEqual({ value: tenantTheme });
      await new Promise((r) => setTimeout(r, 75));
      expect(cacheGet(tenantId, 'theme')).toBeUndefined();
    });

    it('FIFO eviction at size cap drops the oldest insertion-order entry first', () => {
      setCacheMaxEntries(3);
      cacheSet(tenantId, 'a', { v: 1 }, 60);
      cacheSet(tenantId, 'b', { v: 2 }, 60);
      cacheSet(tenantId, 'c', { v: 3 }, 60);
      cacheSet(tenantId, 'd', { v: 4 }, 60);
      expect(cacheSize()).toBe(3);
      expect(cacheGet(tenantId, 'a')).toBeUndefined(); // oldest, evicted
      expect(cacheGet(tenantId, 'b')).toEqual({ value: { v: 2 } });
      expect(cacheGet(tenantId, 'c')).toEqual({ value: { v: 3 } });
      expect(cacheGet(tenantId, 'd')).toEqual({ value: { v: 4 } });
    });

    it('re-inserting an existing key bumps its insertion-order position', () => {
      setCacheMaxEntries(3);
      cacheSet(tenantId, 'a', { v: 1 }, 60);
      cacheSet(tenantId, 'b', { v: 2 }, 60);
      cacheSet(tenantId, 'c', { v: 3 }, 60);
      // Touch 'a' — moves to most-recently-inserted position.
      cacheSet(tenantId, 'a', { v: 1.1 }, 60);
      // Add 'd' — now 'b' is the oldest, evicted.
      cacheSet(tenantId, 'd', { v: 4 }, 60);
      expect(cacheGet(tenantId, 'b')).toBeUndefined();
      expect(cacheGet(tenantId, 'a')).toEqual({ value: { v: 1.1 } });
    });

    it("cache key is per-tenant (same logical namespace doesn't collide across tenants)", () => {
      cacheSet(tenantId, 'theme', tenantTheme, 60);
      cacheSet(otherTenantId, 'theme', platformTheme, 60);
      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({ value: tenantTheme });
      expect(cacheGet<Theme>(otherTenantId, 'theme')).toEqual({ value: platformTheme });
    });
  });

  describe('cache integration with resolveConfig', () => {
    it('cache MISS → DB walk → populates cache on resolve', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme);
      expect(cacheGet(tenantId, 'theme')).toBeUndefined();

      await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );

      const cached = cacheGet<Theme>(tenantId, 'theme');
      expect(cached).toEqual({ value: tenantTheme });
    });

    it('cache HIT short-circuits — returns cached value even when DB row diverges', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      // Pre-populate cache directly with a sentinel value.
      const sentinel: Theme = { primary_color: '#CACHED', secondary_color: '#cached' };
      cacheSet(tenantId, 'theme', sentinel, 60);
      // Insert a different value into DB — bypasses cache invalidation.
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme);

      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toEqual(sentinel);
    });

    it('uses default 60s TTL when consumer omits ttl', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      // The cache entry should remain valid for ~60s; we won't wait
      // 60s, but we can verify the entry exists (TTL applied at set
      // time; fast-path test).
      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({ value: defaultTheme });
      expect(DEFAULT_CONSUMER_TTL_SECONDS).toBe(60);
    });

    it('respects per-consumer ttl override on cache miss', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
        ttl: 0.05, // 50ms
      });
      await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({ value: defaultTheme });
      await new Promise((r) => setTimeout(r, 75));
      expect(cacheGet<Theme>(tenantId, 'theme')).toBeUndefined();
    });

    it('caches null default value to avoid re-walking empty tiers', async () => {
      // No consumer + no DB rows → resolveConfig returns null.
      const r1 = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(r1).toBeNull();
      const cached = cacheGet<Theme>(tenantId, 'theme');
      expect(cached).toEqual({ value: null });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Active invalidation (Q-NEW-F04C-5)
  // ────────────────────────────────────────────────────────────────

  describe('lifecycle invalidation', () => {
    it('successful promoteDraft for tenant.<ns> invalidates the logical-<ns> cache key', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      // Pre-populate cache with sentinel.
      cacheSet(tenantId, 'theme', { primary_color: '#STALE', secondary_color: '#stale' }, 60);

      const draft = await createDraft(db, {
        tenantId,
        namespace: 'tenant.theme',
        schemaVersion: 1,
        draftJson: tenantTheme,
        actor: userActor,
      });
      await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });

      expect(cacheGet(tenantId, 'theme')).toBeUndefined();
    });

    it('successful promoteDraft for platform.<ns> ALSO invalidates logical-<ns> (pessimistic)', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      cacheSet(tenantId, 'theme', defaultTheme, 60);

      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: platformTheme,
        actor: userActor,
      });
      await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });

      expect(cacheGet(tenantId, 'theme')).toBeUndefined();
    });

    it('successful rollbackVersion for tenant.<ns> invalidates the logical-<ns> cache key', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      // Seed v=1 and v=2 directly so rollback has a parent to revert to.
      const v1 = await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme, 1);
      await pgPool.query(
        `INSERT INTO tenant_config_version
          (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
         VALUES ($1, 'tenant.theme', 2, $2, 1, $3::jsonb)`,
        [tenantId, v1, JSON.stringify({ primary_color: '#V2', secondary_color: '#v2' })],
      );

      cacheSet(tenantId, 'theme', { primary_color: '#STALE', secondary_color: '#stale' }, 60);

      await rollbackVersion(db, tenantId, { namespace: 'tenant.theme', actor: userActor });
      expect(cacheGet(tenantId, 'theme')).toBeUndefined();
    });

    it('failed promoteDraft (validation error) leaves cache UNTOUCHED — post-commit invalidation gate', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      // Replace the registered schema with a stricter one to force
      // PromoteValidationError on defensive re-validate.
      const StricterSchema = z.object({
        primary_color: z.string(),
        secondary_color: z.string(),
        tertiary_color: z.string(),
      });

      const draft = await createDraft(db, {
        tenantId,
        namespace: 'tenant.theme',
        schemaVersion: 1,
        draftJson: tenantTheme,
        actor: userActor,
      });

      cacheSet(tenantId, 'theme', { primary_color: '#STALE', secondary_color: '#stale' }, 60);

      // Re-register schema with stricter shape under the SAME version
      // (in-memory mutation; matches Slice C C.3 schema-version mutation
      // rule for not-yet-pinned-by-prod-drafts).
      resetSchemaRegistry();
      registerNamespaceSchema('tenant.theme', StricterSchema, { version: 1 });
      registerNamespaceSchema('platform.theme', StricterSchema, { version: 1 });

      await expect(
        promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor }),
      ).rejects.toThrow(PromoteValidationError);

      // Cache remains populated — failed promote MUST NOT invalidate.
      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({
        value: { primary_color: '#STALE', secondary_color: '#stale' },
      });
    });

    it('failed rollbackVersion (RollbackAtGenesisError) leaves cache UNTOUCHED', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      // Seed only v=1 (no parent — genesis).
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme, 1);
      cacheSet(tenantId, 'theme', { primary_color: '#STALE', secondary_color: '#stale' }, 60);

      await expect(
        rollbackVersion(db, tenantId, { namespace: 'tenant.theme', actor: userActor }),
      ).rejects.toThrow(RollbackAtGenesisError);

      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({
        value: { primary_color: '#STALE', secondary_color: '#stale' },
      });
    });

    it('promoteDraft on a non-prefixed literal namespace does not affect resolver cache', async () => {
      // Register schema for the literal namespace 'foo' (no tier prefix).
      registerNamespaceSchema('foo', ThemeSchema, { version: 1 });
      cacheSet(tenantId, 'theme', defaultTheme, 60);

      const draft = await createDraft(db, {
        tenantId,
        namespace: 'foo',
        schemaVersion: 1,
        draftJson: tenantTheme,
        actor: userActor,
      });
      await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });

      // Cache for unrelated logical namespace 'theme' undisturbed.
      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({ value: defaultTheme });
    });

    it('post-invalidation resolve re-reads from DB and re-populates cache', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      // Pre-populate stale.
      cacheSet(tenantId, 'theme', { primary_color: '#STALE', secondary_color: '#stale' }, 60);

      // Promote new tenant.theme value → invalidates.
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'tenant.theme',
        schemaVersion: 1,
        draftJson: tenantTheme,
        actor: userActor,
      });
      await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });
      expect(cacheGet(tenantId, 'theme')).toBeUndefined();

      // Resolve → re-reads from DB, repopulates cache with fresh value.
      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toEqual(tenantTheme);
      expect(cacheGet<Theme>(tenantId, 'theme')).toEqual({ value: tenantTheme });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Dual-namespace schema registration
  // ────────────────────────────────────────────────────────────────

  describe('registerConfigConsumer dual-namespace shape', () => {
    it('registers the same schema under both tenant.<ns> AND platform.<ns>', () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });

      const tenantEntry = getNamespaceSchema('tenant.theme', 1);
      const platformEntry = getNamespaceSchema('platform.theme', 1);
      expect(tenantEntry).toBeDefined();
      expect(platformEntry).toBeDefined();
      expect(tenantEntry!.schema).toBe(ThemeSchema);
      expect(platformEntry!.schema).toBe(ThemeSchema);
    });

    it('reading via getConfig validates against the registered schema at either tier', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme);
      const r1 = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(r1).toEqual(tenantTheme);

      // Cleanup tenant tier; fall to platform.
      await pgPool.query(`DELETE FROM tenant_config_version WHERE tenant_id = $1`, [tenantId]);
      cacheClear();
      await insertVersion(pgPool, tenantId, 'platform.theme', platformTheme);

      const r2 = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(r2).toEqual(platformTheme);
    });

    it('re-registering the same consumer with same schema reference is idempotent', () => {
      const e1 = registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      const e2 = registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      expect(e1.namespace).toBe('theme');
      expect(e2.namespace).toBe('theme');
      expect(e2.ttlSeconds).toBe(DEFAULT_CONSUMER_TTL_SECONDS);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Schema-version pinning at both tiers
  // ────────────────────────────────────────────────────────────────

  describe('schema-version pinning across tiers', () => {
    it('row pinned to v=N validates against schema registered at v=N', async () => {
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme, 1);
      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toEqual(tenantTheme);
    });

    it('row at v=1 still validates when v=2 also registered (version-keyed lookup)', async () => {
      // v=1 registration via registerConfigConsumer.
      registerConfigConsumer({
        namespace: 'theme',
        schema: ThemeSchema,
        schemaVersion: 1,
        defaultValue: defaultTheme,
      });
      // v=2 schema registered separately at the literal level (e.g.,
      // a future schema bump that hasn't migrated existing rows yet).
      const ThemeV2 = z.object({
        primary_color: z.string(),
        secondary_color: z.string(),
        tertiary_color: z.string(),
      });
      registerNamespaceSchema('tenant.theme', ThemeV2, { version: 2 });
      registerNamespaceSchema('platform.theme', ThemeV2, { version: 2 });

      // Existing row pinned to v=1 — should still resolve correctly.
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme, 1);
      const result = await withTenantContext(testPool, tenantId, (tx) =>
        resolveConfig<Theme>(tx, tenantId, 'theme'),
      );
      expect(result).toEqual(tenantTheme);
    });

    it("throws NamespaceSchemaNotRegisteredError when a row's pinned schema_version has no registration", async () => {
      // Row pinned to v=1 but no schema registered at all.
      await insertVersion(pgPool, tenantId, 'tenant.theme', tenantTheme, 1);
      await expect(
        withTenantContext(testPool, tenantId, (tx) => resolveConfig<Theme>(tx, tenantId, 'theme')),
      ).rejects.toThrow(/schema/i);
    });
  });
});

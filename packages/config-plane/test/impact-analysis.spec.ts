/**
 * F04 Slice D — impact-analysis tests.
 *
 * Coverage breakdown across 5 describe blocks:
 *   - `diffJson` — pure-function structural-diff helper
 *   - `pathMatchesKeyPath` — bidirectional matching
 *   - `detectSchemaIncompatibilities` — schema-drift detection (pure
 *     function over an injected ConsumerEntry list)
 *   - `analyzeImpact` — end-to-end against real Postgres, exercises
 *     the registered-consumer surface
 *   - `promoteDraft` impact-aware integration — override path,
 *     block path, separate-transaction audit emission
 *
 * Phase 1 single-consumer-per-namespace limit (per
 * `getImpactEligibleConsumers` JSDoc): the registry's underlying Map
 * is keyed on logical namespace alone, so a second
 * `registerConfigConsumer` call for the same namespace overwrites
 * the first. "Multi-consumer aggregation" tests therefore exercise
 * single-consumer-multi-axis (one consumer, multiple breaking-change
 * kinds) rather than multiple-consumers-same-namespace, which is
 * deferred to first-consumer-driven future work.
 *
 * Test pattern — every test resets BOTH schema-registry AND
 * consumer-registry in beforeEach to prevent leakage across tests.
 * `cleanupConfigPlaneState` clears DB state.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  // Slice D — impact-analysis surface
  analyzeImpact,
  ImpactAnalysisDraftNotFoundError,
  ImpactBlockedError,
  diffJson,
  pathMatchesKeyPath,
  detectSchemaIncompatibilities,
  // Slice C — consumer registry
  registerConfigConsumer,
  resetConsumerRegistry,
  type ConsumerEntry,
  // Slice A — schema registry
  registerNamespaceSchema,
  resetSchemaRegistry,
  // Slice B — lifecycle
  createDraft,
  promoteDraft,
  type Actor,
} from '../src/index.js';
import { cleanupConfigPlaneState } from './_utils/cleanup.js';

// ──────────────────────────────────────────────────────────────────────
// Pool builders (same shape as lifecycle.spec.ts / rollback.spec.ts)
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// Shared schemas — designed for incompatibility (drift tests)
// ──────────────────────────────────────────────────────────────────────

// v=1: primary_color is a STRING; data shape A
const themeSchemaV1 = z.object({
  primary_color: z.string(),
  logo_url: z.string(),
});

// v=2: primary_color is a NUMBER; data validating v=2 fails v=1
// (string vs number is the simplest unambiguous incompatibility).
const themeSchemaV2 = z.object({
  primary_color: z.number(),
  logo_url: z.string(),
});

const userActor: Actor = {
  type: 'user',
  id: randomUUID(),
  description: 'F04 Slice D impact test user',
};

// ──────────────────────────────────────────────────────────────────────
// Helper — bind tenant context inside a transaction for analyzeImpact
// standalone calls.
// ──────────────────────────────────────────────────────────────────────

async function inTenant<T>(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  fn: (tx: NodePgDatabase<Record<string, never>>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Block 1: diffJson — pure structural diff
// ──────────────────────────────────────────────────────────────────────

describe('diffJson — structural diff helper', () => {
  it('reports a key added at the top level as kind=added', () => {
    const before = { a: 1 };
    const after = { a: 1, b: 2 };
    const diff = diffJson(before, after);
    expect(diff).toEqual([{ kind: 'added', path: 'b' }]);
  });

  it('reports a key removed at the top level as kind=removed', () => {
    const before = { a: 1, b: 2 };
    const after = { a: 1 };
    const diff = diffJson(before, after);
    expect(diff).toEqual([{ kind: 'removed', path: 'b' }]);
  });

  it('reports a value change as kind=modified at the leaf path', () => {
    const before = { a: 1 };
    const after = { a: 2 };
    const diff = diffJson(before, after);
    expect(diff).toEqual([{ kind: 'modified', path: 'a' }]);
  });

  it('uses dot-notation for nested paths (3+ levels deep)', () => {
    const before = { theme: { colors: { primary: '#fff' } } };
    const after = { theme: { colors: { primary: '#000' } } };
    const diff = diffJson(before, after);
    expect(diff).toEqual([{ kind: 'modified', path: 'theme.colors.primary' }]);
  });

  it('compares arrays positionally (different length, modified element)', () => {
    const before = { sections: ['hero', 'about'] };
    const after = { sections: ['hero', 'team', 'contact'] };
    const diff = diffJson(before, after);
    // index 1 modified ('about' → 'team'), index 2 added ('contact')
    expect(diff).toEqual([
      { kind: 'modified', path: 'sections.1' },
      { kind: 'added', path: 'sections.2' },
    ]);
  });

  it('returns an empty array for identical objects', () => {
    const before = { a: 1, b: { c: 2 } };
    const after = { a: 1, b: { c: 2 } };
    expect(diffJson(before, after)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Block 2: pathMatchesKeyPath — bidirectional
// ──────────────────────────────────────────────────────────────────────

describe('pathMatchesKeyPath — bidirectional matching', () => {
  it('matches when consumer keyPath is a prefix of the diff path', () => {
    expect(pathMatchesKeyPath('theme.colors.primary', 'theme.colors')).toBe(true);
  });

  it('matches when the diff path is a prefix of the consumer keyPath (parent removal)', () => {
    expect(pathMatchesKeyPath('theme.colors', 'theme.colors.primary')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(pathMatchesKeyPath('layout.padding', 'theme.colors')).toBe(false);
  });

  it('matches identical paths exactly', () => {
    expect(pathMatchesKeyPath('theme.colors.primary', 'theme.colors.primary')).toBe(true);
  });

  it('does not match a path that merely shares a leading substring without dot boundary', () => {
    // 'theme_colors' would otherwise match 'theme' under naive prefix logic.
    expect(pathMatchesKeyPath('theme_colors', 'theme')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Block 3: detectSchemaIncompatibilities — pure helper over consumers
// ──────────────────────────────────────────────────────────────────────

describe('detectSchemaIncompatibilities — schema-version drift', () => {
  beforeEach(() => {
    resetSchemaRegistry();
    resetConsumerRegistry();
  });

  it('emits schema_incompatible when consumer pinned at v=N but draft data fails v=N validation', () => {
    // Register v=1 (string) AND v=2 (number) for tenant.theme.
    registerNamespaceSchema('tenant.theme', themeSchemaV1, { version: 1 });
    registerNamespaceSchema('tenant.theme', themeSchemaV2, { version: 2 });

    // Build a fabricated impact-eligible consumer pinned at v=1.
    const consumer: ConsumerEntry = {
      namespace: 'theme',
      schemaVersion: 1,
      defaultValue: null,
      ttlSeconds: 60,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    };

    // Data that validates v=2 but fails v=1 (number vs string).
    const draftJson = { primary_color: 42, logo_url: '/logo.png' };
    const findings = detectSchemaIncompatibilities('tenant.theme', draftJson, [consumer]);

    expect(findings.warnings).toEqual([]);
    expect(findings.breaking).toHaveLength(1);
    expect(findings.breaking[0]!.kind).toBe('schema_incompatible');
    expect(findings.breaking[0]!.consumer_module).toBe('UX01');
  });

  it("emits a warning (not breaking) when consumer's pinned schema is not registered", () => {
    // Register only v=1 — consumer pinned at v=99 has no schema registered.
    registerNamespaceSchema('tenant.theme', themeSchemaV1, { version: 1 });

    const consumer: ConsumerEntry = {
      namespace: 'theme',
      schemaVersion: 99,
      defaultValue: null,
      ttlSeconds: 60,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    };

    const findings = detectSchemaIncompatibilities(
      'tenant.theme',
      { primary_color: '#fff', logo_url: '/x' },
      [consumer],
    );

    expect(findings.breaking).toEqual([]);
    expect(findings.warnings).toHaveLength(1);
    expect(findings.warnings[0]!.kind).toBe('consumer_pinned_schema_not_registered');
    expect(findings.warnings[0]!.consumer_module).toBe('UX01');
  });

  it('produces no findings when data validates the consumer pinned schema', () => {
    registerNamespaceSchema('tenant.theme', themeSchemaV1, { version: 1 });

    const consumer: ConsumerEntry = {
      namespace: 'theme',
      schemaVersion: 1,
      defaultValue: null,
      ttlSeconds: 60,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    };

    const findings = detectSchemaIncompatibilities(
      'tenant.theme',
      { primary_color: '#fff', logo_url: '/x' },
      [consumer],
    );

    expect(findings.breaking).toEqual([]);
    expect(findings.warnings).toEqual([]);
  });

  it('classifies multiple consumers independently per pinned version', () => {
    registerNamespaceSchema('tenant.theme', themeSchemaV1, { version: 1 });
    registerNamespaceSchema('tenant.theme', themeSchemaV2, { version: 2 });

    const c1: ConsumerEntry = {
      namespace: 'theme',
      schemaVersion: 1,
      defaultValue: null,
      ttlSeconds: 60,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    };
    const c2: ConsumerEntry = {
      namespace: 'theme',
      schemaVersion: 2,
      defaultValue: null,
      ttlSeconds: 60,
      consumerModule: 'AC02',
      breakingChangePolicy: 'warn',
    };

    // Data validates v=2 but fails v=1.
    const findings = detectSchemaIncompatibilities(
      'tenant.theme',
      { primary_color: 42, logo_url: '/x' },
      [c1, c2],
    );

    expect(findings.warnings).toEqual([]);
    expect(findings.breaking).toHaveLength(1);
    expect(findings.breaking[0]!.consumer_module).toBe('UX01');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Block 4: analyzeImpact — end-to-end against Postgres
// ──────────────────────────────────────────────────────────────────────

describe('analyzeImpact — end-to-end', () => {
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
       VALUES ('f04-slice-d-impact-test-a', 'F04 Slice D Impact Test A', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    tenantId = a.rows[0]!.id;

    const b = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('f04-slice-d-impact-test-b', 'F04 Slice D Impact Test B', 'STANDARD', 'PROVISIONING')
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
    resetSchemaRegistry();
    resetConsumerRegistry();
  });

  afterEach(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
    await cleanupConfigPlaneState(pgPool, otherTenantId);
  });

  it('emits key_removed when a registered keyPath is removed from the draft', async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
      keyPaths: ['logo_url'],
    });

    // Seed parent version with logo_url present.
    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/logo.png' })],
    );

    // Draft removes logo_url.
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000' },
      actor: userActor,
    });

    const report = await inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, draft.id));

    expect(report.affected_consumers).toHaveLength(1);
    expect(report.affected_consumers[0]!.consumer_module).toBe('UX01');
    const removed = report.breaking_changes.filter((b) => b.kind === 'key_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.consumer_module).toBe('UX01');
  });

  it('namespace-level consumer (no keyPaths) matches any change', async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
      // no keyPaths — namespace-level
    });

    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/x' })],
    );

    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      // change a field that is NOT in the consumer's hypothetical keyPaths
      draftJson: { primary_color: '#000', logo_url: '/x' },
      actor: userActor,
    });

    const report = await inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, draft.id));

    expect(report.affected_consumers).toHaveLength(1);
    expect(report.affected_consumers[0]!.matched_key_paths).toEqual([]); // namespace-level
  });

  it('aggregates multiple breaking-change kinds for one consumer', async () => {
    // Register v=1 (string) AND v=2 (number, incompatible).
    registerNamespaceSchema('tenant.theme', themeSchemaV2, { version: 2 });
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1, // consumer pinned at v=1 (string)
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'block',
      keyPaths: ['primary_color', 'logo_url'],
    });

    // Parent at v=1.
    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/old.png' })],
    );

    // Draft at v=2 with primary_color number, logo_url removed.
    // Expected breaking changes for UX01:
    //   - key_removed (logo_url)
    //   - schema_incompatible (data fails v=1 string schema)
    //   - policy_block (consumer policy='block', changes touch its keyPaths)
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 2,
      draftJson: { primary_color: 42 },
      actor: userActor,
    });

    const report = await inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, draft.id));

    const kinds = new Set(report.breaking_changes.map((b) => b.kind));
    expect(kinds.has('key_removed')).toBe(true);
    expect(kinds.has('schema_incompatible')).toBe(true);
    expect(kinds.has('policy_block')).toBe(true);
    // All breaking changes are for the same consumer (Phase 1 single-consumer-per-namespace).
    for (const b of report.breaking_changes) {
      expect(b.consumer_module).toBe('UX01');
    }
  });

  it('genesis path (no parent version) skips structural diff but runs schema-drift', async () => {
    registerNamespaceSchema('tenant.theme', themeSchemaV2, { version: 2 });
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1, // pinned at v=1 (string)
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    });

    // No parent version — genesis.
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 2,
      draftJson: { primary_color: 42, logo_url: '/x' }, // fails v=1
      actor: userActor,
    });

    const report = await inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, draft.id));

    // No data-axis breakage at genesis (no key_removed possible without prior state).
    const kinds = report.breaking_changes.map((b) => b.kind);
    expect(kinds).not.toContain('key_removed');
    expect(kinds).not.toContain('policy_block');
    // Schema-drift still runs.
    expect(kinds).toContain('schema_incompatible');
  });

  it('returns empty report when no impact-eligible consumers are registered', async () => {
    // Consumer omits consumerModule → impact-skipped (Slice C compat).
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
    });

    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' },
      actor: userActor,
    });

    const report = await inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, draft.id));

    expect(report.affected_consumers).toEqual([]);
    expect(report.breaking_changes).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('strips tenant.* prefix to find the logical-namespace consumer', async () => {
    registerConfigConsumer({
      namespace: 'theme', // logical namespace
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    });

    // Draft uses literal 'tenant.theme' — should still match the 'theme' consumer.
    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/x' })],
    );
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' },
      actor: userActor,
    });

    const report = await inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, draft.id));
    expect(report.affected_consumers).toHaveLength(1);
    expect(report.affected_consumers[0]!.consumer_module).toBe('UX01');
  });

  it('strips platform.* prefix to find the same logical-namespace consumer', async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    });

    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'platform.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/x' })],
    );
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'platform.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' },
      actor: userActor,
    });

    const report = await inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, draft.id));
    expect(report.affected_consumers).toHaveLength(1);
    expect(report.affected_consumers[0]!.consumer_module).toBe('UX01');
  });

  it('throws ImpactAnalysisDraftNotFoundError when the draftId does not exist', async () => {
    const ghostId = randomUUID();
    await expect(
      inTenant(db, tenantId, (tx) => analyzeImpact(tx, tenantId, ghostId)),
    ).rejects.toBeInstanceOf(ImpactAnalysisDraftNotFoundError);
  });

  it("multi-tenant isolation — tenant A's draft doesn't surface in tenant B's analyzeImpact", async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
    });

    // Create draft for tenant A.
    const draftA = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' },
      actor: userActor,
    });

    // Bind tenant B and call analyzeImpact with tenant A's draftId.
    // Because RLS scopes config_draft to tenant B, the row isn't visible →
    // ImpactAnalysisDraftNotFoundError surfaces.
    await expect(
      inTenant(db, otherTenantId, (tx) => analyzeImpact(tx, otherTenantId, draftA.id)),
    ).rejects.toBeInstanceOf(ImpactAnalysisDraftNotFoundError);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Block 5: promoteDraft impact-aware integration
// ──────────────────────────────────────────────────────────────────────

describe('promoteDraft impact-aware lifecycle integration (Slice D)', () => {
  let pgPool: Pool;
  let testPool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  let tenantId: string;

  beforeAll(async () => {
    pgPool = makePostgresPool();
    testPool = makeTestUserPool();
    db = drizzle(testPool);

    const a = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('f04-slice-d-promote-test', 'F04 Slice D Promote Test', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    tenantId = a.rows[0]!.id;
  });

  afterAll(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
    await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    await pgPool.end();
    await testPool.end();
  });

  beforeEach(() => {
    resetSchemaRegistry();
    resetConsumerRegistry();
  });

  afterEach(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
  });

  it('non-breaking promote succeeds without confirmBreakingChanges; payload omits override metadata', async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'warn',
      keyPaths: ['logo_url'],
    });
    // Parent + draft change a field NOT in the consumer's keyPaths.
    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/x' })],
    );
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' }, // logo_url unchanged → no impact
      actor: userActor,
    });

    const result = await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });
    expect(result.versionNumber).toBe(2);
    expect(result.impact.breaking_changes).toEqual([]);

    // Audit row's after_state should NOT have breaking_changes_overridden.
    const auditRows = await pgPool.query<{ payload: { after_state?: Record<string, unknown> } }>(
      `SELECT payload FROM audit_event
         WHERE tenant_id = $1 AND action = 'CONFIG_VERSION_PROMOTED'
         ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(auditRows.rows[0]!.payload.after_state?.breaking_changes_overridden).toBeUndefined();
  });

  it('block path: promote without override + breaking changes throws ImpactBlockedError carrying the report', async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'block',
      keyPaths: ['primary_color'],
    });
    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/x' })],
    );
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' }, // touches policy=block keyPath
      actor: userActor,
    });

    let caught: ImpactBlockedError | undefined;
    try {
      await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });
    } catch (err) {
      if (err instanceof ImpactBlockedError) caught = err;
      else throw err;
    }
    expect(caught).toBeInstanceOf(ImpactBlockedError);
    expect(caught!.report.breaking_changes.length).toBeGreaterThan(0);
    expect(caught!.report.affected_consumers[0]!.consumer_module).toBe('UX01');

    // The promote rolled back — no CONFIG_VERSION_PROMOTED row should reference
    // THIS draft. Filter by from_draft_id (set on every promote's after_state)
    // to avoid leakage from prior successful promotes — audit_event's
    // append-only trigger forbids DELETE so cleanupConfigPlaneState's
    // .catch silently no-ops on audit_event between tests.
    const promotedRows = await pgPool.query(
      `SELECT 1 FROM audit_event
         WHERE tenant_id = $1
           AND action = 'CONFIG_VERSION_PROMOTED'
           AND payload -> 'after_state' ->> 'from_draft_id' = $2`,
      [tenantId, draft.id],
    );
    expect(promotedRows.rows.length).toBe(0);
    // No new tenant_config_version row beyond the seeded v=1.
    const versionRows = await pgPool.query(
      `SELECT version_number FROM tenant_config_version WHERE tenant_id = $1 AND namespace = 'tenant.theme'`,
      [tenantId],
    );
    expect(versionRows.rows.length).toBe(1);
  });

  it('block path also emits CONFIG_PROMOTE_BLOCKED audit row in a SEPARATE transaction (load-bearing)', async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'block',
      keyPaths: ['primary_color'],
    });
    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/x' })],
    );
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' },
      actor: userActor,
    });

    await expect(
      promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor }),
    ).rejects.toBeInstanceOf(ImpactBlockedError);

    // The CONFIG_PROMOTE_BLOCKED audit row must exist even though promote rolled back.
    // If the audit emission accidentally ran inside the rolled-back transaction,
    // this assertion would fail. This is the load-bearing test for D.5's
    // separate-transaction pattern.
    const auditRows = await pgPool.query<{ payload: { after_state: Record<string, unknown> } }>(
      `SELECT payload FROM audit_event
         WHERE tenant_id = $1 AND action = 'CONFIG_PROMOTE_BLOCKED'
         ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(auditRows.rows.length).toBe(1);
    const after = auditRows.rows[0]!.payload.after_state;
    expect(after.draft_id).toBe(draft.id);
    expect(after.namespace).toBe('tenant.theme');
    expect(after.breaking_change_count).toBeGreaterThan(0);
    expect(Array.isArray(after.breaking_change_kinds)).toBe(true);
    expect(Array.isArray(after.affected_consumers)).toBe(true);
  });

  it('override path: confirmBreakingChanges=true succeeds and enriches CONFIG_VERSION_PROMOTED payload', async () => {
    registerConfigConsumer({
      namespace: 'theme',
      schema: themeSchemaV1,
      schemaVersion: 1,
      defaultValue: null,
      consumerModule: 'UX01',
      breakingChangePolicy: 'block',
      keyPaths: ['primary_color'],
    });
    await pgPool.query(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, 'tenant.theme', 1, NULL, 1, $2::jsonb)`,
      [tenantId, JSON.stringify({ primary_color: '#fff', logo_url: '/x' })],
    );
    const draft = await createDraft(db, {
      tenantId,
      namespace: 'tenant.theme',
      schemaVersion: 1,
      draftJson: { primary_color: '#000', logo_url: '/x' },
      actor: userActor,
    });

    const result = await promoteDraft(db, tenantId, {
      draftId: draft.id,
      actor: userActor,
      confirmBreakingChanges: true,
    });
    expect(result.versionNumber).toBe(2);
    // Result.impact carries the report detected pre-INSERT.
    expect(result.impact.breaking_changes.length).toBeGreaterThan(0);

    // Audit row's after_state must carry the override metadata.
    const auditRows = await pgPool.query<{ payload: { after_state: Record<string, unknown> } }>(
      `SELECT payload FROM audit_event
         WHERE tenant_id = $1 AND action = 'CONFIG_VERSION_PROMOTED'
         ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(auditRows.rows.length).toBe(1);
    const after = auditRows.rows[0]!.payload.after_state;
    expect(after.breaking_changes_overridden).toBe(true);
    expect(Array.isArray(after.affected_consumers)).toBe(true);
    expect((after.affected_consumers as { consumer_module: string }[])[0]!.consumer_module).toBe(
      'UX01',
    );
    expect(Array.isArray(after.breaking_change_kinds)).toBe(true);
  });
});

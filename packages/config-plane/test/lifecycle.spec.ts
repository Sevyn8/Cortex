/**
 * F04 Slice B lifecycle tests — `createDraft`, `updateDraft`,
 * `discardDraft`. Exercises against real Postgres + drizzle + audit-
 * events emission, mirroring the F02 tenants.spec pattern.
 *
 * Tests run as `test_user` (NOSUPERUSER NOBYPASSRLS); the lifecycle
 * helpers bind `app.tenant_id` internally so RLS policies fire
 * against the bound tenant. Tenant-row creation (NO RLS table) +
 * direct audit_event reads use a postgres-user pool.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  createDraft,
  discardDraft,
  DraftConcurrencyError,
  DraftNotFoundError,
  promoteDraft,
  PromoteConcurrencyError,
  PromoteValidationError,
  SchemaNotRegisteredError,
  registerNamespaceSchema,
  resetSchemaRegistry,
  updateDraft,
  validateDraft,
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

const userActor: Actor = {
  type: 'user',
  id: randomUUID(),
  description: 'F04 lifecycle test user',
};

const otherUserActor: Actor = {
  type: 'user',
  id: randomUUID(),
  description: 'F04 lifecycle test user B',
};

const serviceActor: Actor = {
  type: 'service',
  id: randomUUID(),
  description: 'F04 lifecycle test service',
};

describe('@cortex/config-plane lifecycle (Slice B)', () => {
  let pgPool: Pool;
  let testPool: Pool;
  let db: NodePgDatabase<Record<string, never>>;
  let tenantId: string;

  beforeAll(async () => {
    pgPool = makePostgresPool();
    testPool = makeTestUserPool();
    db = drizzle(testPool);

    const r = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('f04-slice-b-lifecycle-test', 'F04 Slice B Lifecycle Test', 'STANDARD', 'PROVISIONING')
       ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
    );
    tenantId = r.rows[0]!.id;
  });

  afterAll(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
    await pgPool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    await pgPool.end();
    await testPool.end();
  });

  beforeEach(() => {
    resetSchemaRegistry();
    registerNamespaceSchema('platform.theme', ThemeSchema, { version: 1 });
  });

  afterEach(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
  });

  // ─────────────────────────────────────────────────────────────────
  // createDraft
  // ─────────────────────────────────────────────────────────────────

  describe('createDraft', () => {
    it('inserts an active draft and emits CONFIG_DRAFT_CREATED', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#FF0000', secondary_color: '#00FF00' },
        actor: userActor,
      });
      expect(draft.namespace).toBe('platform.theme');
      expect(draft.schema_version).toBe(1);
      expect(draft.status).toBe('active');
      expect(draft.validation_state).toBe('unvalidated');
      expect(draft.created_by_user_id).toBe(userActor.id);

      const audit = await pgPool.query<{ action: string }>(
        `SELECT action FROM audit_event
         WHERE tenant_id = $1 AND resource = $2`,
        [tenantId, `config_draft:${draft.id}`],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.action).toBe('CONFIG_DRAFT_CREATED');
    });

    it('throws SchemaNotRegisteredError when (namespace, schemaVersion) is unknown', async () => {
      await expect(
        createDraft(db, {
          tenantId,
          namespace: 'platform.theme',
          schemaVersion: 99,
          draftJson: {},
          actor: userActor,
        }),
      ).rejects.toThrow(SchemaNotRegisteredError);
    });

    it('rejects a duplicate active draft for same (tenant, namespace, author) via UNIQUE', async () => {
      await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#001', secondary_color: '#002' },
        actor: userActor,
      });
      // Second active draft from the same author → UNIQUE violation
      // (substrate-enforced; surfaces as a pg error not a custom one).
      await expect(
        createDraft(db, {
          tenantId,
          namespace: 'platform.theme',
          schemaVersion: 1,
          draftJson: { primary_color: '#011', secondary_color: '#012' },
          actor: userActor,
        }),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('allows a fresh active draft after a previous one is discarded', async () => {
      const first = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#001', secondary_color: '#002' },
        actor: userActor,
      });
      await discardDraft(db, tenantId, { draftId: first.id, actor: userActor });

      const second = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#011', secondary_color: '#012' },
        actor: userActor,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('active');
    });

    it('accepts service actors (Q-NEW-F04B-8 — both user + service)', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#000', secondary_color: '#111' },
        actor: serviceActor,
      });
      expect(draft.created_by_user_id).toBe(serviceActor.id);

      const audit = await pgPool.query<{ actor_type: string }>(
        `SELECT actor_type FROM audit_event
         WHERE tenant_id = $1 AND resource = $2`,
        [tenantId, `config_draft:${draft.id}`],
      );
      expect(audit.rows[0]!.actor_type).toBe('service');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // updateDraft
  // ─────────────────────────────────────────────────────────────────

  describe('updateDraft', () => {
    it('updates draft_json + resets validation_state; emits CONFIG_DRAFT_UPDATED', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      // Force a validation_state mutation to confirm it gets reset.
      await pgPool.query(`UPDATE config_draft SET validation_state = 'valid' WHERE id = $1`, [
        created.id,
      ]);

      const updated = await updateDraft(db, tenantId, {
        draftId: created.id,
        draftJson: { primary_color: '#C', secondary_color: '#D' },
        expectedUpdatedAt: created.updated_at,
        actor: userActor,
      });
      expect((updated.draft_json as { primary_color: string }).primary_color).toBe('#C');
      expect(updated.validation_state).toBe('unvalidated');
      expect(updated.validation_errors).toBeNull();

      const audit = await pgPool.query<{ action: string }>(
        `SELECT action FROM audit_event
         WHERE tenant_id = $1 AND resource = $2 ORDER BY occurred_at`,
        [tenantId, `config_draft:${created.id}`],
      );
      // CREATED + UPDATED.
      expect(audit.rows.map((r) => r.action)).toEqual([
        'CONFIG_DRAFT_CREATED',
        'CONFIG_DRAFT_UPDATED',
      ]);
    });

    it('throws DraftConcurrencyError on stale expectedUpdatedAt', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#1', secondary_color: '#2' },
        actor: userActor,
      });
      const stale = new Date(created.updated_at.getTime() - 1000);

      await expect(
        updateDraft(db, tenantId, {
          draftId: created.id,
          draftJson: { primary_color: '#3', secondary_color: '#4' },
          expectedUpdatedAt: stale,
          actor: userActor,
        }),
      ).rejects.toThrow(DraftConcurrencyError);
    });

    it('throws DraftNotFoundError when actor is not the author', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#1', secondary_color: '#2' },
        actor: userActor,
      });

      await expect(
        updateDraft(db, tenantId, {
          draftId: created.id,
          draftJson: { primary_color: '#3', secondary_color: '#4' },
          expectedUpdatedAt: created.updated_at,
          actor: otherUserActor,
        }),
      ).rejects.toThrow(DraftNotFoundError);
    });

    it('throws DraftNotFoundError on unknown draftId', async () => {
      await expect(
        updateDraft(db, tenantId, {
          draftId: randomUUID(),
          draftJson: { primary_color: '#1', secondary_color: '#2' },
          expectedUpdatedAt: new Date(),
          actor: userActor,
        }),
      ).rejects.toThrow(DraftNotFoundError);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // validateDraft
  // ─────────────────────────────────────────────────────────────────

  describe('validateDraft', () => {
    it('returns valid:true and updates draft.validation_state when draft passes Zod', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      const result = await validateDraft(db, tenantId, {
        draftId: created.id,
        actor: userActor,
      });
      expect(result.valid).toBe(true);
      expect(result.draft.validation_state).toBe('valid');
      expect(result.draft.validation_errors).toBeNull();
    });

    it('returns valid:false + errors and persists Zod issues when draft fails', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        // primary_color missing required field
        draftJson: { primary_color: '#A' } as unknown as Record<string, unknown>,
        actor: userActor,
      });
      const result = await validateDraft(db, tenantId, {
        draftId: created.id,
        actor: userActor,
      });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error('expected invalid');
      expect(result.draft.validation_state).toBe('invalid');
      expect(Array.isArray(result.draft.validation_errors)).toBe(true);
      expect(result.errors.issues.length).toBeGreaterThan(0);
    });

    it('emits CONFIG_DRAFT_VALIDATED with payload metadata (READ verb)', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#1', secondary_color: '#2' },
        actor: userActor,
      });
      await validateDraft(db, tenantId, { draftId: created.id, actor: userActor });

      const audit = await pgPool.query<{
        action: string;
        payload: { outcome: string; error_count: number };
      }>(
        `SELECT action, payload FROM audit_event
         WHERE tenant_id = $1 AND resource = $2 AND action = 'CONFIG_DRAFT_VALIDATED'`,
        [tenantId, `config_draft:${created.id}`],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.payload.outcome).toBe('valid');
      expect(audit.rows[0]!.payload.error_count).toBe(0);
    });

    it('throws SchemaNotRegisteredError when the schema for (namespace, schema_version) is gone', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      // Wipe the registry — simulates schema unregistered between
      // create and validate (rare but possible if a consumer module
      // unloads).
      resetSchemaRegistry();

      await expect(
        validateDraft(db, tenantId, { draftId: created.id, actor: userActor }),
      ).rejects.toThrow(SchemaNotRegisteredError);
    });

    it('throws DraftNotFoundError when actor is not the author', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      await expect(
        validateDraft(db, tenantId, { draftId: created.id, actor: otherUserActor }),
      ).rejects.toThrow(DraftNotFoundError);
    });

    it('is idempotent — re-validation reflects current state', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      const r1 = await validateDraft(db, tenantId, { draftId: created.id, actor: userActor });
      expect(r1.valid).toBe(true);

      // Re-run; should still be valid + emit a second VALIDATED audit row.
      const r2 = await validateDraft(db, tenantId, { draftId: created.id, actor: userActor });
      expect(r2.valid).toBe(true);

      const audit = await pgPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_event
         WHERE tenant_id = $1 AND resource = $2 AND action = 'CONFIG_DRAFT_VALIDATED'`,
        [tenantId, `config_draft:${created.id}`],
      );
      expect(audit.rows[0]!.count).toBe('2');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // promoteDraft
  // ─────────────────────────────────────────────────────────────────

  describe('promoteDraft', () => {
    it('creates v=1 with parent_version_id=NULL when no prior version exists for (tenant, namespace)', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });

      const result = await promoteDraft(db, tenantId, {
        draftId: draft.id,
        actor: userActor,
      });
      expect(result.versionNumber).toBe(1);
      expect(result.draft.status).toBe('promoted');
      expect(result.draft.promoted_to_version_id).toBe(result.versionId);

      const version = await pgPool.query<{
        namespace: string;
        version_number: number;
        parent_version_id: string | null;
      }>(
        `SELECT namespace, version_number, parent_version_id FROM tenant_config_version
         WHERE id = $1`,
        [result.versionId],
      );
      expect(version.rows[0]!.namespace).toBe('platform.theme');
      expect(version.rows[0]!.version_number).toBe(1);
      expect(version.rows[0]!.parent_version_id).toBeNull();
    });

    it('creates v=N+1 with parent_version_id pointing at v=N for an existing namespace', async () => {
      // Seed a v=1 row directly (post-Slice-A namespace shape).
      const seeded = await pgPool.query<{ id: string }>(
        `INSERT INTO tenant_config_version
          (tenant_id, namespace, version_number, config_json, schema_version)
         VALUES ($1, 'platform.theme', 1, '{}'::jsonb, 1)
         RETURNING id`,
        [tenantId],
      );
      const v1Id = seeded.rows[0]!.id;

      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#X', secondary_color: '#Y' },
        actor: userActor,
      });
      const result = await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });

      expect(result.versionNumber).toBe(2);

      const version = await pgPool.query<{ parent_version_id: string | null }>(
        `SELECT parent_version_id FROM tenant_config_version WHERE id = $1`,
        [result.versionId],
      );
      expect(version.rows[0]!.parent_version_id).toBe(v1Id);
    });

    it('emits CONFIG_VERSION_PROMOTED with after_state metadata', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#1', secondary_color: '#2' },
        actor: userActor,
      });
      const result = await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });

      const audit = await pgPool.query<{ action: string; payload: unknown }>(
        `SELECT action, payload FROM audit_event
         WHERE tenant_id = $1 AND resource = $2`,
        [tenantId, `tenant_config_version:${result.versionId}`],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.action).toBe('CONFIG_VERSION_PROMOTED');
    });

    it('throws PromoteValidationError when defensive re-validate fails (Q-NEW-F04B-6)', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      // Validate first — passes.
      await validateDraft(db, tenantId, { draftId: draft.id, actor: userActor });
      // Re-register schema with a stricter shape (simulates schema bump
      // between validate and promote).
      const StricterSchema = z.object({
        primary_color: z.string(),
        secondary_color: z.string(),
        tertiary_color: z.string(), // newly required
      });
      // Replace v=1 with stricter — clear and re-register since
      // registerNamespaceSchema rejects re-registration with same key.
      resetSchemaRegistry();
      registerNamespaceSchema('platform.theme', StricterSchema, { version: 1 });

      await expect(
        promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor }),
      ).rejects.toThrow(PromoteValidationError);
    });

    it('throws SchemaNotRegisteredError when schema deregistered between validate and promote', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      resetSchemaRegistry(); // wipe the registry entirely

      await expect(
        promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor }),
      ).rejects.toThrow(SchemaNotRegisteredError);
    });

    it('throws DraftNotFoundError when actor is not the author', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      await expect(
        promoteDraft(db, tenantId, { draftId: draft.id, actor: otherUserActor }),
      ).rejects.toThrow(DraftNotFoundError);
    });

    it('throws DraftNotFoundError when draft is already promoted', async () => {
      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });
      await expect(
        promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor }),
      ).rejects.toThrow(DraftNotFoundError);
    });

    it('audit-honesty: exactly 1 CONFIG_VERSION_PROMOTED audit row per successful promote (regardless of retry)', async () => {
      // Per Q-NEW-F04B-6 + D13 retry contract: the audit emission
      // happens INSIDE the per-attempt transaction, AFTER the
      // INSERT. If the first attempt's INSERT fails with 23505 and
      // the retry fires, the first transaction aborts WITHOUT
      // emitting audit (Postgres aborts on first error; subsequent
      // commands no-op until ROLLBACK). The retry opens a fresh
      // transaction that emits exactly one row on success.
      //
      // Single-process tests can't deterministically force two
      // 23505s (requires concurrent-session interleaving), so this
      // test exercises the structural invariant: after a successful
      // promote, audit count for the resource is exactly 1, NOT 2.
      // This holds for both retry-fired and no-retry paths because
      // the emit is post-INSERT in the same transaction.
      //
      // Pre-seed v=1 + v=2 directly to make promote compute v=3; this
      // exercises the optimistic-INSERT subquery path. If a future
      // refactor accidentally emitted audit BEFORE the INSERT (bad)
      // or emitted twice on retry (bad), this length=1 assertion
      // would catch both regressions.
      await pgPool.query(
        `INSERT INTO tenant_config_version
          (tenant_id, namespace, version_number, config_json, schema_version)
         VALUES ($1, 'platform.theme', 1, '{}'::jsonb, 1),
                ($1, 'platform.theme', 2, '{}'::jsonb, 1)`,
        [tenantId],
      );

      const draft = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#A', secondary_color: '#B' },
        actor: userActor,
      });
      const result = await promoteDraft(db, tenantId, { draftId: draft.id, actor: userActor });

      expect(result.versionNumber).toBe(3);

      // Audit count for the resource MUST be 1.
      const audit = await pgPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_event
         WHERE tenant_id = $1 AND resource = $2 AND action = 'CONFIG_VERSION_PROMOTED'`,
        [tenantId, `tenant_config_version:${result.versionId}`],
      );
      expect(audit.rows[0]!.count).toBe('1');
    });

    it('PromoteConcurrencyError class smoke test (constructor + message shape)', () => {
      // Forcing two consecutive 23505s requires concurrent-session
      // interleaving (worker-thread coordination); single-process
      // tests can't do this deterministically. The audit-honesty
      // test above exercises the optimistic INSERT subquery path
      // under no-contention; PostgreSQL's UNIQUE enforcement
      // exercises the retry-on-conflict path implicitly when CI's
      // ephemeral Postgres runs against parallel test workers.
      const err = new PromoteConcurrencyError(tenantId, 'platform.theme');
      expect(err.name).toBe('PromoteConcurrencyError');
      expect(err.message).toMatch(/lost the race after retry/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // discardDraft
  // ─────────────────────────────────────────────────────────────────

  describe('discardDraft', () => {
    it('sets status=discarded; emits CONFIG_DRAFT_DISCARDED', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#1', secondary_color: '#2' },
        actor: userActor,
      });
      await discardDraft(db, tenantId, { draftId: created.id, actor: userActor });

      const after = await pgPool.query<{ status: string }>(
        `SELECT status FROM config_draft WHERE id = $1`,
        [created.id],
      );
      expect(after.rows[0]!.status).toBe('discarded');

      const audit = await pgPool.query<{ action: string }>(
        `SELECT action FROM audit_event
         WHERE tenant_id = $1 AND resource = $2 ORDER BY occurred_at`,
        [tenantId, `config_draft:${created.id}`],
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'CONFIG_DRAFT_CREATED',
        'CONFIG_DRAFT_DISCARDED',
      ]);
    });

    it('throws DraftNotFoundError when actor is not the author', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#1', secondary_color: '#2' },
        actor: userActor,
      });
      await expect(
        discardDraft(db, tenantId, { draftId: created.id, actor: otherUserActor }),
      ).rejects.toThrow(DraftNotFoundError);
    });

    it('throws DraftNotFoundError on already-discarded draft', async () => {
      const created = await createDraft(db, {
        tenantId,
        namespace: 'platform.theme',
        schemaVersion: 1,
        draftJson: { primary_color: '#1', secondary_color: '#2' },
        actor: userActor,
      });
      await discardDraft(db, tenantId, { draftId: created.id, actor: userActor });
      await expect(
        discardDraft(db, tenantId, { draftId: created.id, actor: userActor }),
      ).rejects.toThrow(DraftNotFoundError);
    });
  });
});

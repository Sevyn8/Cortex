/**
 * Migration 0015 substrate verification — config_draft table shape +
 * UNIQUE constraint behavior per Q-NEW-F04B-1.
 *
 * Concurrent inserts of duplicate (tenant, namespace, author) where
 * status='active' MUST fail with 23505 (unique_violation). Same
 * (tenant, namespace, author) with different status (e.g., one
 * 'discarded' + one 'active') MUST succeed — the partial index only
 * covers active rows.
 *
 * Pattern mirrors `services/foundation/test/control_plane.spec.ts`'s
 * UNIQUE-composite tests: insert via tenant-bound transaction (RLS
 * isolated), capture SQLSTATE on duplicate, assert.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withTenantContext } from '@cortex/canonical-schema/rls-test';
import { randomUUID } from 'node:crypto';
import { cleanupConfigPlaneState } from './_utils/cleanup.js';

function makePostgresPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error('PGPASSWORD not set; required for config-draft-constraints spec.');
  }
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
  if (!password) {
    throw new Error('PGPASSWORD not set; required for config-draft-constraints spec.');
  }
  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'test_user',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

describe('migration 0015 — config_draft table + UNIQUE constraint', () => {
  let pgPool: Pool;
  let testPool: Pool;
  let tenantId: string;
  const authorA = randomUUID();
  const authorB = randomUUID();

  beforeAll(async () => {
    pgPool = makePostgresPool();
    testPool = makeTestUserPool();
    const r = await pgPool.query<{ id: string }>(
      `INSERT INTO tenant (external_id, display_name, tier, status)
       VALUES ('f04-slice-b-config-draft-test', 'F04 Slice B config_draft Test', 'STANDARD', 'PROVISIONING')
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

  it('INSERT a single active draft succeeds', async () => {
    await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
         VALUES ($1, $2, '{}'::jsonb, $3)`,
        [tenantId, 'platform.theme', authorA],
      );
    });

    const { rows } = await pgPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM config_draft WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]!.count).toBe('1');

    // Cleanup for the next test.
    await pgPool.query(`DELETE FROM config_draft WHERE tenant_id = $1`, [tenantId]);
  });

  it('rejects a second active draft with same (tenant, namespace, author) — 23505', async () => {
    await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
         VALUES ($1, $2, '{"v":1}'::jsonb, $3)`,
        [tenantId, 'platform.theme', authorA],
      );
    });

    let captured: { code?: string } | undefined;
    try {
      await withTenantContext(testPool, tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
           VALUES ($1, $2, '{"v":2}'::jsonb, $3)`,
          [tenantId, 'platform.theme', authorA],
        );
      });
    } catch (err) {
      captured = err as { code?: string };
    }
    expect(captured?.code).toBe('23505');

    await pgPool.query(`DELETE FROM config_draft WHERE tenant_id = $1`, [tenantId]);
  });

  it('allows a fresh active draft after the first is discarded (partial UNIQUE only covers active)', async () => {
    // First active draft.
    await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
         VALUES ($1, $2, '{"v":1}'::jsonb, $3)`,
        [tenantId, 'platform.theme', authorA],
      );
    });
    // Mark it discarded.
    await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `UPDATE config_draft SET status = 'discarded'
         WHERE tenant_id = $1 AND namespace = $2 AND created_by_user_id = $3`,
        [tenantId, 'platform.theme', authorA],
      );
    });
    // Fresh active draft now allowed.
    await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
         VALUES ($1, $2, '{"v":2}'::jsonb, $3)`,
        [tenantId, 'platform.theme', authorA],
      );
    });

    const { rows } = await pgPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM config_draft
       WHERE tenant_id = $1 AND namespace = $2 AND created_by_user_id = $3`,
      [tenantId, 'platform.theme', authorA],
    );
    expect(rows[0]!.count).toBe('2');

    await pgPool.query(`DELETE FROM config_draft WHERE tenant_id = $1`, [tenantId]);
  });

  it('allows two active drafts with same (tenant, namespace) but different authors', async () => {
    await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
         VALUES ($1, $2, '{"v":"a"}'::jsonb, $3),
                ($1, $2, '{"v":"b"}'::jsonb, $4)`,
        [tenantId, 'platform.theme', authorA, authorB],
      );
    });

    const { rows } = await pgPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM config_draft
       WHERE tenant_id = $1 AND namespace = $2 AND status = 'active'`,
      [tenantId, 'platform.theme'],
    );
    expect(rows[0]!.count).toBe('2');

    await pgPool.query(`DELETE FROM config_draft WHERE tenant_id = $1`, [tenantId]);
  });

  it('allows two active drafts with same (tenant, author) but different namespaces', async () => {
    await withTenantContext(testPool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
         VALUES ($1, $2, '{}'::jsonb, $3),
                ($1, $4, '{}'::jsonb, $3)`,
        [tenantId, 'platform.theme', authorA, 'tenant.i18n'],
      );
    });

    const { rows } = await pgPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM config_draft
       WHERE tenant_id = $1 AND created_by_user_id = $2 AND status = 'active'`,
      [tenantId, authorA],
    );
    expect(rows[0]!.count).toBe('2');

    await pgPool.query(`DELETE FROM config_draft WHERE tenant_id = $1`, [tenantId]);
  });

  it('rejects an INSERT outside the tenant context — RLS isolation (42501)', async () => {
    let captured: { code?: string } | undefined;
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      // Deliberately do NOT bind app.tenant_id.
      await client.query(
        `INSERT INTO config_draft (tenant_id, namespace, draft_json, created_by_user_id)
         VALUES ($1, $2, '{}'::jsonb, $3)`,
        [tenantId, 'platform.theme', authorA],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      captured = err as { code?: string };
    } finally {
      client.release();
    }
    expect(captured?.code).toBe('42501');
  });
});

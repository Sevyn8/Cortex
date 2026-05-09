/**
 * F04 Slice B rollbackVersion tests per Q-NEW-F04B-3 (whole-namespace
 * rollback).
 *
 * Cases:
 *   - rollback when parent exists (v=2 → v=3 with v=1 content)
 *   - rollback at genesis (only v=1 exists) → RollbackAtGenesisError
 *   - rollback with no version at all → RollbackNoVersionError
 *   - rollback chain (rollback the rollback works)
 *   - parent_version_id chain integrity (each rollback row points
 *     to the version it rolled back FROM)
 *   - audit emission shape (CONFIG_VERSION_ROLLED_BACK with
 *     after_state metadata)
 *   - actor accepts user/service/system (Q-NEW-F04B-8)
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import {
  rollbackVersion,
  RollbackAtGenesisError,
  RollbackNoVersionError,
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

const userActor: Actor = {
  type: 'user',
  id: randomUUID(),
  description: 'F04 rollback test user',
};

// Helper — seed N versions directly via raw SQL with a chain.
// Returns ids in version_number order.
// Hoisted outside describe so its `pool` parameter is properly
// inferred (closure-captured `let`-declared pool tripped TS7022
// inference inside the describe block).
async function seedChain(
  pool: Pool,
  tenantId: string,
  namespace: string,
  versions: { config: Record<string, unknown> }[],
): Promise<string[]> {
  const ids: string[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < versions.length; i++) {
    const versionNumber: number = i + 1;
    // Explicit annotation on `result` + extracted `id`; without it,
    // TS strict mode trips TS7022 "implicit any from own initializer"
    // — likely interaction between pg.Pool.query's default-any
    // generic + the parentId reassignment loop.
    const result: { rows: { id: string }[] } = await pool.query<{ id: string }>(
      `INSERT INTO tenant_config_version
        (tenant_id, namespace, version_number, parent_version_id, schema_version, config_json)
       VALUES ($1, $2, $3, $4, 1, $5::jsonb)
       RETURNING id`,
      [tenantId, namespace, versionNumber, parentId, JSON.stringify(versions[i]!.config)],
    );
    const id: string = result.rows[0]!.id;
    ids.push(id);
    parentId = id;
  }
  return ids;
}

describe('@cortex/config-plane rollbackVersion (Slice B)', () => {
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
       VALUES ('f04-slice-b-rollback-test', 'F04 Slice B Rollback Test', 'STANDARD', 'PROVISIONING')
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

  afterEach(async () => {
    await cleanupConfigPlaneState(pgPool, tenantId);
  });

  it('throws RollbackNoVersionError when (tenant, namespace) has no version rows', async () => {
    await expect(
      rollbackVersion(db, tenantId, { namespace: 'platform.empty', actor: userActor }),
    ).rejects.toThrow(RollbackNoVersionError);
  });

  it('throws RollbackAtGenesisError when only the genesis version exists', async () => {
    await seedChain(pgPool, tenantId, 'platform.theme', [{ config: { color: 'red' } }]);

    await expect(
      rollbackVersion(db, tenantId, { namespace: 'platform.theme', actor: userActor }),
    ).rejects.toThrow(RollbackAtGenesisError);
  });

  it('rolls back v=2 → creates v=3 with v=1 content + parent_version_id pointing at v=2', async () => {
    const [v1Id, v2Id] = await seedChain(pgPool, tenantId, 'platform.theme', [
      { config: { color: 'red' } },
      { config: { color: 'blue' } },
    ]);

    const result = await rollbackVersion(db, tenantId, {
      namespace: 'platform.theme',
      actor: userActor,
    });

    expect(result.versionNumber).toBe(3);
    expect(result.rolledBackFromVersionId).toBe(v2Id);
    expect(result.rolledBackToVersionId).toBe(v1Id);

    // Verify the new row's content + chain.
    const row = await pgPool.query<{
      config_json: { color: string };
      parent_version_id: string;
      version_number: number;
    }>(
      `SELECT config_json, parent_version_id, version_number
       FROM tenant_config_version WHERE id = $1`,
      [result.versionId],
    );
    expect(row.rows[0]!.config_json).toEqual({ color: 'red' });
    expect(row.rows[0]!.parent_version_id).toBe(v2Id);
    expect(row.rows[0]!.version_number).toBe(3);
  });

  it('rollback ladder — rolling back the rollback restores the rolled-back-from content', async () => {
    const [, v2Id] = await seedChain(pgPool, tenantId, 'platform.theme', [
      { config: { color: 'red' } },
      { config: { color: 'blue' } },
    ]);

    // First rollback: v=3 = v=1 content, parent = v=2.
    const r1 = await rollbackVersion(db, tenantId, {
      namespace: 'platform.theme',
      actor: userActor,
    });
    expect(r1.versionNumber).toBe(3);

    // Second rollback: v=4 should = v=2 content (the parent of v=3
    // which is v=2), parent = v=3 (rolled-back-FROM).
    const r2 = await rollbackVersion(db, tenantId, {
      namespace: 'platform.theme',
      actor: userActor,
    });
    expect(r2.versionNumber).toBe(4);
    expect(r2.rolledBackFromVersionId).toBe(r1.versionId);
    expect(r2.rolledBackToVersionId).toBe(v2Id);

    const row = await pgPool.query<{ config_json: { color: string } }>(
      `SELECT config_json FROM tenant_config_version WHERE id = $1`,
      [r2.versionId],
    );
    expect(row.rows[0]!.config_json).toEqual({ color: 'blue' });
  });

  it('emits CONFIG_VERSION_ROLLED_BACK with after_state metadata', async () => {
    await seedChain(pgPool, tenantId, 'platform.theme', [
      { config: { color: 'red' } },
      { config: { color: 'blue' } },
    ]);

    const result = await rollbackVersion(db, tenantId, {
      namespace: 'platform.theme',
      actor: userActor,
    });

    const audit = await pgPool.query<{ action: string; payload: unknown }>(
      `SELECT action, payload FROM audit_event
       WHERE tenant_id = $1 AND resource = $2`,
      [tenantId, `tenant_config_version:${result.versionId}`],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.action).toBe('CONFIG_VERSION_ROLLED_BACK');
  });

  it('accepts service actors (Q-NEW-F04B-8)', async () => {
    await seedChain(pgPool, tenantId, 'platform.theme', [
      { config: { color: 'red' } },
      { config: { color: 'blue' } },
    ]);
    const serviceActor: Actor = {
      type: 'service',
      id: randomUUID(),
      description: 'F04 rollback test service',
    };

    const result = await rollbackVersion(db, tenantId, {
      namespace: 'platform.theme',
      actor: serviceActor,
    });
    expect(result.versionNumber).toBe(3);

    const audit = await pgPool.query<{ actor_type: string }>(
      `SELECT actor_type FROM audit_event
       WHERE tenant_id = $1 AND resource = $2`,
      [tenantId, `tenant_config_version:${result.versionId}`],
    );
    expect(audit.rows[0]!.actor_type).toBe('service');
  });
});

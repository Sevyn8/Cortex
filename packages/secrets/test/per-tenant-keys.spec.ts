/**
 * Tests for `getKeyForTenant` — F02 Slice A swap (sub-phase 5.2).
 *
 * Pre-swap (Phase 1 stub) the function was sync + DB-free; the tests
 * asserted on the static env-key resolution and same-key-for-all-tenants
 * behavior. Post-swap the function is async + queries `tenant_kms_key`,
 * so tests run against a real Postgres (skipped locally without the
 * proxy; CI exercises against the ephemeral pgvector container).
 *
 * SA15 (locked 2026-04-27): operational `[SECRETS-AUDIT]` log emission
 * preserved on success and error paths — exercised by the audit-log
 * spec tests below.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createLogger } from '@cortex/observability';
import { createLogCapture, type LogCapture } from '@cortex/observability/test-utils';
import { getKeyForTenant } from '../src/per-tenant-keys.js';
import { __resetForTesting, __setLoggerForTesting } from '../src/audit.js';
import { SecretsValidationError, TenantKmsKeyNotFoundError } from '../src/errors.js';

const ENV_KEY_PATTERN =
  /^projects\/.+\/locations\/.+\/keyRings\/.+\/cryptoKeys\/cortex-general-key$/;

let pool: Pool;
let db: NodePgDatabase<Record<string, never>>;
let logCapture: LogCapture;
const seededTenantIds: string[] = [];

beforeAll(() => {
  process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
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
  // Cleanup seeded fixtures. tenant_kms_key has FK ON DELETE RESTRICT;
  // delete child rows under tenant binding, then the tenant row.
  for (const id of seededTenantIds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
      await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
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

beforeEach(() => {
  logCapture = createLogCapture();
  __setLoggerForTesting(createLogger({ moduleId: 'cortex-secrets', destination: logCapture }));
});

afterEach(() => {
  __resetForTesting();
});

/**
 * Seed a tenant + tenant_kms_key row for a fresh tenantId. Returns the
 * tenantId. Cleanup runs in afterAll. RLS bind required for the
 * tenant_kms_key INSERT (FOR ALL policy from migration 0009).
 */
async function seedTenant(label: string, kmsKeyName?: string): Promise<string> {
  const tenantId = randomUUID();
  const externalId = `test-getkey-${label}-${tenantId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO tenant (id, external_id, display_name, tier) VALUES ($1, $2, $3, $4)`,
    [tenantId, externalId, 'Test', 'STANDARD'],
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(
      `INSERT INTO tenant_kms_key (tenant_id, kms_key_resource_name) VALUES ($1, $2)`,
      [
        tenantId,
        kmsKeyName ??
          'projects/sevyn8-cortex-dev/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/cortex-general-key',
      ],
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
 * Wrap a getKeyForTenant call in a transaction with `app.tenant_id`
 * bound (matches the production caller contract). Returns the
 * resolved key resource name.
 */
async function getKeyBound(tenantId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return getKeyForTenant(tx, tenantId);
  });
}

describe('getKeyForTenant — happy path', () => {
  it('returns the kms_key_resource_name from tenant_kms_key for the given tenant', async () => {
    const tenantId = await seedTenant('happy');
    const key = await getKeyBound(tenantId);
    expect(key).toMatch(ENV_KEY_PATTERN);
  });

  it('returns the row-specific key (per-tenant binding actually consulted)', async () => {
    const tenantId = await seedTenant(
      'distinct',
      'projects/sevyn8-cortex-dev/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/per-tenant-marker',
    );
    const key = await getKeyBound(tenantId);
    // Row's kms_key_resource_name verbatim — proves the swap consults
    // the table rather than returning a static env path.
    expect(key).toContain('per-tenant-marker');
  });
});

describe('getKeyForTenant — input validation', () => {
  it('rejects non-UUID tenantId with SecretsValidationError', async () => {
    await expect(getKeyForTenant(db, 'not-a-uuid')).rejects.toBeInstanceOf(SecretsValidationError);
  });

  it('rejects empty tenantId with SecretsValidationError', async () => {
    await expect(getKeyForTenant(db, '')).rejects.toBeInstanceOf(SecretsValidationError);
  });
});

describe('getKeyForTenant — not-found', () => {
  it('throws TenantKmsKeyNotFoundError when no tenant_kms_key row exists', async () => {
    const ghostId = randomUUID();
    await expect(getKeyBound(ghostId)).rejects.toBeInstanceOf(TenantKmsKeyNotFoundError);
  });

  it('not-found message includes the tenantId for forensic context', async () => {
    const ghostId = randomUUID();
    await expect(getKeyBound(ghostId)).rejects.toThrow(new RegExp(ghostId));
  });
});

describe('getKeyForTenant — operational audit log (SA15)', () => {
  it('emits audit log on success with operation, tenant_id, key_id, outcome=ok', async () => {
    const tenantId = await seedTenant('audit-ok');
    await getKeyBound(tenantId);
    await logCapture.flush();

    const audit = logCapture.logs.find(
      (l) => (l as Record<string, unknown>).operation === 'getKeyForTenant',
    );
    expect(audit).toMatchObject({
      namespace: 'secrets-audit',
      operation: 'getKeyForTenant',
      outcome: 'ok',
      tenant_id: tenantId,
      error_code: null,
    });
    expect((audit as Record<string, unknown>).key_id).toMatch(ENV_KEY_PATTERN);
  });

  it('emits audit log on validation failure with outcome=error, error_code=VALIDATION', async () => {
    await expect(getKeyForTenant(db, 'bad')).rejects.toBeInstanceOf(SecretsValidationError);
    await logCapture.flush();

    const audit = logCapture.logs.find(
      (l) => (l as Record<string, unknown>).operation === 'getKeyForTenant',
    );
    expect(audit).toMatchObject({
      operation: 'getKeyForTenant',
      outcome: 'error',
      error_code: 'VALIDATION',
      tenant_id: null,
    });
  });

  it('emits audit log on not-found with outcome=error, error_code=NOT_FOUND', async () => {
    const ghostId = randomUUID();
    await expect(getKeyBound(ghostId)).rejects.toBeInstanceOf(TenantKmsKeyNotFoundError);
    await logCapture.flush();

    const audit = logCapture.logs.find(
      (l) => (l as Record<string, unknown>).operation === 'getKeyForTenant',
    );
    expect(audit).toMatchObject({
      operation: 'getKeyForTenant',
      outcome: 'error',
      error_code: 'NOT_FOUND',
      tenant_id: ghostId,
    });
  });
});

/**
 * Tests for the key-rotation worker route (F02 Slice D D.2).
 *
 * The route's surface (per Q-NEW-D-7 + ADR-LIFECYCLE-001 §3):
 *   - POST /v1/_workers/key-rotation
 *   - OIDC validation on the Authorization bearer (stub-injected here).
 *   - Body validation via @hono/zod-validator (tenant_id uuid + trigger).
 *   - Calls tenants.rotateKeys; maps thrown errors to RFC 9457
 *     problem-details via app.onError + the workspace error-mapper.
 *
 * KMS is stubbed via @cortex/secrets's __setClientFactoryForTesting.
 * Postgres is real (matches the rest of the workspace's test
 * convention; sandbox is the dev p09-repro instance).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { Hono } from 'hono';
import { problemDetailsHandler } from 'hono-problem-details';
import { __setClientFactoryForTesting } from '@cortex/secrets';
import { tenants } from '@cortex/tenant-context';
import { mapError } from '../../../src/error-mapper.js';
import { buildKeyRotationWorkerRoutes } from '../../../src/routes/workers/key-rotation.js';
import type { OidcValidator } from '../../../src/routes/workers/_shared/oidc.js';
import type { AppConfig } from '../../../src/config.js';
import { getPool } from '../../../../../packages/tenant-context/test/helpers/db.js';

const RUN_TAG = randomUUID().slice(0, 8);

const TEST_CONFIG: AppConfig = {
  PORT: 8080,
  NODE_ENV: 'test',
  GCP_PROJECT_ID: 'sevyn8-cortex-dev',
  CLOUDSQL_INSTANCE_CONNECTION_NAME: 'sevyn8-cortex-dev:asia-south1:cortex-dev-postgres',
  PGDATABASE: 'cortex',
  PG_IAM_USER: 'tenant-lifecycle-runtime@sevyn8-cortex-dev.iam',
  COMMIT_SHA: 'test',
  ENABLE_TEST_ROUTES: false,
  CLOUD_TASKS_INVOKER_SA_EMAIL: '',
};

interface KmsStub {
  encrypt: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
  getCryptoKey: ReturnType<typeof vi.fn>;
  createCryptoKeyVersion: ReturnType<typeof vi.fn>;
  updateCryptoKeyPrimaryVersion: ReturnType<typeof vi.fn>;
  destroyCryptoKeyVersion: ReturnType<typeof vi.fn>;
  destroyed: string[];
}

function inMemoryKms(): KmsStub {
  // Same shape as packages/tenant-context/test/rotate-keys.spec.ts —
  // initial primary = 1; createCryptoKeyVersion mints (primary + 1);
  // updateCryptoKeyPrimaryVersion promotes.
  const versionCounter = new Map<string, number>();
  const destroyed: string[] = [];
  return {
    destroyed,
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    getCryptoKey: vi.fn((req: { name?: string }) => {
      const key = req.name ?? '';
      const v = versionCounter.get(key) ?? 1;
      return Promise.resolve([{ name: key, primary: { name: `${key}/cryptoKeyVersions/${v}` } }]);
    }),
    createCryptoKeyVersion: vi.fn((req: { parent?: string }) => {
      const parent = req.parent ?? '';
      const current = versionCounter.get(parent) ?? 1;
      const next = current + 1;
      return Promise.resolve([{ name: `${parent}/cryptoKeyVersions/${next}` }]);
    }),
    updateCryptoKeyPrimaryVersion: vi.fn((req: { name?: string; cryptoKeyVersionId?: string }) => {
      const key = req.name ?? '';
      const v = parseInt(req.cryptoKeyVersionId ?? '', 10);
      if (!Number.isNaN(v)) versionCounter.set(key, v);
      return Promise.resolve([{}]);
    }),
    destroyCryptoKeyVersion: vi.fn((req: { name?: string }) => {
      destroyed.push(req.name ?? '');
      return Promise.resolve([{}]);
    }),
  };
}

const ALWAYS_OK_VALIDATOR: OidcValidator = () => Promise.resolve({ ok: true });

function buildTestApp(opts: { validator?: OidcValidator; pool: Pool }): Hono {
  const app = new Hono();
  app.route(
    '/',
    buildKeyRotationWorkerRoutes({
      config: TEST_CONFIG,
      pool: opts.pool,
      ...(opts.validator !== undefined && { validateOidc: opts.validator }),
    }),
  );
  app.onError(
    problemDetailsHandler({
      mapError: (err) => mapError(err),
      autoInstance: true,
    }),
  );
  return app;
}

describe('POST /v1/_workers/key-rotation', () => {
  let pool: Pool;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    process.env.GCP_PROJECT_ID ??= 'sevyn8-cortex-dev';
    pool = getPool();
    // FORCE-RLS on audit_event is operator-side schema setup, NOT a
    // per-test concern. `pnpm db:reset` (see
    // docs/runbooks/local-development.md §"Schema-level reset")
    // transfers audit_event ownership to test_user + applies FORCE
    // ROW LEVEL SECURITY there; CI's test-DB setup mirrors it. This
    // test assumes that's already in place. If you see RLS-related
    // failures, run `pnpm db:reset` and confirm
    // `SELECT tableowner FROM pg_tables WHERE tablename = 'audit_event'`
    // returns `test_user`.
  });

  afterAll(async () => {
    for (const id of createdTenantIds) {
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
          await client.query('DELETE FROM tenant_kms_key WHERE tenant_id = $1', [id]);
          await client.query('COMMIT');
        } catch {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      } catch {
        // ignore
      }
      await pool.query('DELETE FROM tenant WHERE id = $1', [id]);
    }
    await pool.end();
    __setClientFactoryForTesting(null);
  });

  beforeEach(() => {
    __setClientFactoryForTesting(() => inMemoryKms() as never);
  });

  afterEach(() => {
    __setClientFactoryForTesting(null);
  });

  // ───────────────────────────────────────────────────────────────────
  // OIDC validation
  // ───────────────────────────────────────────────────────────────────

  describe('OIDC validation', () => {
    it('missing Authorization header → 401', async () => {
      const app = buildTestApp({ pool });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: randomUUID(), trigger: 'on_demand' }),
      });
      expect(res.status).toBe(401);
    });

    it('malformed bearer (no "Bearer " prefix) → 401', async () => {
      const app = buildTestApp({ pool });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'NotBearer xyz',
        },
        body: JSON.stringify({ tenant_id: randomUUID(), trigger: 'on_demand' }),
      });
      expect(res.status).toBe(401);
    });

    it('invalid token (validator returns wrong-issuer-email) → 401', async () => {
      const wrongIssuer: OidcValidator = () =>
        Promise.resolve({ ok: false, reason: 'wrong-issuer-email' });
      const app = buildTestApp({ pool, validator: wrongIssuer });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer fake.token.here',
        },
        body: JSON.stringify({ tenant_id: randomUUID(), trigger: 'on_demand' }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { message?: string };
      expect(body.message).toMatch(/wrong-issuer-email/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Body schema validation
  // ───────────────────────────────────────────────────────────────────

  describe('body schema', () => {
    it('missing tenant_id → 400', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer x',
        },
        body: JSON.stringify({ trigger: 'on_demand' }),
      });
      expect(res.status).toBe(400);
    });

    it('invalid uuid → 400', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer x',
        },
        body: JSON.stringify({ tenant_id: 'not-a-uuid', trigger: 'on_demand' }),
      });
      expect(res.status).toBe(400);
    });

    it('invalid trigger → 400', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer x',
        },
        body: JSON.stringify({ tenant_id: randomUUID(), trigger: 'asap' }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Happy path + error mapping
  // ───────────────────────────────────────────────────────────────────

  describe('handler', () => {
    it('happy path → 200 with tenant_id + last_key_rotated_at', async () => {
      // Seed an ACTIVE tenant via the public API.
      const createDb = await import('drizzle-orm/node-postgres');
      const db = createDb.drizzle(pool);
      const created = await tenants.create(
        db,
        {
          externalId: `worker-happy-${RUN_TAG}`,
          displayName: 'Worker Happy',
          tier: 'STANDARD',
          initialStatus: 'ACTIVE',
        },
        { actor: { type: 'service', id: 'test', description: 'happy seed' } },
      );
      createdTenantIds.push(created.id);

      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer x',
        },
        body: JSON.stringify({ tenant_id: created.id, trigger: 'on_demand' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tenant_id?: string;
        last_key_rotated_at?: string | null;
      };
      expect(body.tenant_id).toBe(created.id);
      expect(body.last_key_rotated_at).not.toBeNull();
    });

    it('non-existent tenant → 404 (TenantNotFoundError mapped)', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer x',
        },
        body: JSON.stringify({ tenant_id: randomUUID(), trigger: 'on_demand' }),
      });
      expect(res.status).toBe(404);
    });

    it('SUSPENDED tenant → 409 (TenantStatusError mapped)', async () => {
      const createDb = await import('drizzle-orm/node-postgres');
      const db = createDb.drizzle(pool);
      const created = await tenants.create(
        db,
        {
          externalId: `worker-conflict-${RUN_TAG}`,
          displayName: 'Worker Conflict',
          tier: 'STANDARD',
          initialStatus: 'ACTIVE',
        },
        { actor: { type: 'service', id: 'test', description: 'conflict seed' } },
      );
      createdTenantIds.push(created.id);
      await tenants.suspend(db, created.id, 'block rotation', {
        actor: { type: 'service', id: 'test' },
      });

      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR });
      const res = await app.request('/v1/_workers/key-rotation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer x',
        },
        body: JSON.stringify({ tenant_id: created.id, trigger: 'on_demand' }),
      });
      expect(res.status).toBe(409);
    });
  });
});

/**
 * Tests for the provisioning worker route (F02 Slice D D.4.5).
 *
 * The route's surface (per Q-NEW-D-7 + ADR-LIFECYCLE-001 §3 +
 * convention §7.4.2):
 *   - POST /v1/_workers/provision
 *   - OIDC validation on the Authorization bearer (stub-injected here
 *     via the shared `_shared/oidc.ts` validator type).
 *   - Body validation via @hono/zod-validator (snake_case wire format:
 *     tenant_id uuid + actor_type + actor_id + actor_description?).
 *   - Calls `provisioningWorker(db, payload)` from `@cortex/tenant-context`
 *     after transforming the snake_case body to the library's
 *     camelCase `ProvisioningTaskPayload`. A stub worker is injected
 *     via the route's `worker?` build option so these tests assert
 *     wiring correctness without driving real DB-side state machine
 *     transitions (those are covered by the library's own tests in
 *     `packages/tenant-context/test/provisioning-worker.spec.ts`).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { Hono } from 'hono';
import { problemDetailsHandler } from 'hono-problem-details';
import { mapError } from '../../../src/error-mapper.js';
import {
  buildProvisioningWorkerRoutes,
  type ProvisioningWorkerFn,
} from '../../../src/routes/workers/provisioning.js';
import type { OidcValidator } from '../../../src/routes/workers/_shared/oidc.js';
import type { AppConfig } from '../../../src/config.js';
import { getPool } from '../../../../../packages/tenant-context/test/helpers/db.js';

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

const ALWAYS_OK_VALIDATOR: OidcValidator = () => Promise.resolve({ ok: true });
const NOOP_WORKER: ProvisioningWorkerFn = () => Promise.resolve();

function buildTestApp(opts: {
  validator?: OidcValidator;
  worker?: ProvisioningWorkerFn;
  pool: Pool;
}): Hono {
  const app = new Hono();
  app.route(
    '/',
    buildProvisioningWorkerRoutes({
      config: TEST_CONFIG,
      pool: opts.pool,
      ...(opts.validator !== undefined && { validateOidc: opts.validator }),
      ...(opts.worker !== undefined && { worker: opts.worker }),
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

function bodyJson(payload: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

const VALID_BODY = {
  tenant_id: randomUUID(),
  actor_type: 'service' as const,
  actor_id: 'test-caller',
  actor_description: 'unit test',
};

describe('POST /v1/_workers/provision', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = getPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  // ── OIDC ───────────────────────────────────────────────────────────
  describe('OIDC validation', () => {
    it('missing Authorization header → 401', async () => {
      const app = buildTestApp({ pool, worker: NOOP_WORKER });
      const res = await app.request('/v1/_workers/provision', bodyJson(VALID_BODY));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.message).toMatch(/missing-bearer-token/);
    });

    it('malformed token → 401 with reason wired', async () => {
      const validator: OidcValidator = () =>
        Promise.resolve({ ok: false, reason: 'invalid-token' });
      const app = buildTestApp({ pool, validator, worker: NOOP_WORKER });
      const res = await app.request('/v1/_workers/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer garbage' },
        body: JSON.stringify(VALID_BODY),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { message?: string };
      expect(body.message).toMatch(/invalid-token/);
    });

    it('wrong-issuer-email → 401', async () => {
      const validator: OidcValidator = () =>
        Promise.resolve({ ok: false, reason: 'wrong-issuer-email' });
      const app = buildTestApp({ pool, validator, worker: NOOP_WORKER });
      const res = await app.request('/v1/_workers/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: JSON.stringify(VALID_BODY),
      });
      expect(res.status).toBe(401);
    });

    it('valid OIDC + valid body → 200 (worker invoked)', async () => {
      const worker = vi.fn<ProvisioningWorkerFn>(() => Promise.resolve());
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker });
      const res = await app.request('/v1/_workers/provision', bodyJson(VALID_BODY));
      expect(res.status).toBe(200);
      expect(worker).toHaveBeenCalledOnce();
    });
  });

  // ── Body schema ────────────────────────────────────────────────────
  describe('body validation', () => {
    it('missing tenant_id → 400', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker: NOOP_WORKER });
      const { actor_type, actor_id, actor_description } = VALID_BODY;
      const res = await app.request(
        '/v1/_workers/provision',
        bodyJson({ actor_type, actor_id, actor_description }),
      );
      expect(res.status).toBe(400);
    });

    it('non-uuid tenant_id → 400', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker: NOOP_WORKER });
      const res = await app.request(
        '/v1/_workers/provision',
        bodyJson({ ...VALID_BODY, tenant_id: 'not-a-uuid' }),
      );
      expect(res.status).toBe(400);
    });

    it('invalid actor_type enum → 400', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker: NOOP_WORKER });
      const res = await app.request(
        '/v1/_workers/provision',
        bodyJson({ ...VALID_BODY, actor_type: 'robot' }),
      );
      expect(res.status).toBe(400);
    });

    it('strict body schema rejects extra keys → 400', async () => {
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker: NOOP_WORKER });
      const res = await app.request(
        '/v1/_workers/provision',
        bodyJson({ ...VALID_BODY, unexpected_field: 'x' }),
      );
      expect(res.status).toBe(400);
    });

    it('omits actor_description when undefined (optional field)', async () => {
      const worker = vi.fn<ProvisioningWorkerFn>(() => Promise.resolve());
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker });
      const { tenant_id, actor_type, actor_id } = VALID_BODY;
      const res = await app.request(
        '/v1/_workers/provision',
        bodyJson({ tenant_id, actor_type, actor_id }),
      );
      expect(res.status).toBe(200);
      const passedPayload = worker.mock.calls[0]?.[1];
      expect(passedPayload?.actorDescription).toBeUndefined();
    });
  });

  // ── Snake → camel transform ─────────────────────────────────────────
  describe('wire-to-library payload transform', () => {
    it('transforms snake_case body → camelCase ProvisioningTaskPayload', async () => {
      const worker = vi.fn<ProvisioningWorkerFn>(() => Promise.resolve());
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker });
      await app.request('/v1/_workers/provision', bodyJson(VALID_BODY));
      expect(worker).toHaveBeenCalledOnce();
      const passedPayload = worker.mock.calls[0]?.[1];
      if (passedPayload === undefined) throw new Error('worker not invoked');
      expect(passedPayload.tenantId).toBe(VALID_BODY.tenant_id);
      expect(passedPayload.actorType).toBe(VALID_BODY.actor_type);
      expect(passedPayload.actorId).toBe(VALID_BODY.actor_id);
      expect(passedPayload.actorDescription).toBe(VALID_BODY.actor_description);
    });
  });

  // ── Handler error → 500 (Cloud Tasks retries) ──────────────────────
  describe('handler errors', () => {
    it('worker throws → 500 (transient; Cloud Tasks retries)', async () => {
      const worker: ProvisioningWorkerFn = () => Promise.reject(new Error('smoke test failed'));
      const app = buildTestApp({ pool, validator: ALWAYS_OK_VALIDATOR, worker });
      const res = await app.request('/v1/_workers/provision', bodyJson(VALID_BODY));
      expect(res.status).toBe(500);
    });
  });
});

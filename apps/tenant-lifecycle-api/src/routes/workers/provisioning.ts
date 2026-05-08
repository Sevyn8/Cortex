/**
 * Cloud Tasks worker route for tenant provisioning. Mirrors the
 * D.2 key-rotation route shape (OIDC + body schema + handler) per
 * Q-NEW-D-7. Lives on the same `tenant-lifecycle-shared` Cloud Run
 * service under the `/v1/_workers/*` prefix that bypasses the
 * user-tenant-context middleware.
 *
 * Pipeline:
 *   1. OIDC validation (shared `_shared/oidc.ts`) — verify the
 *      inbound `Authorization: Bearer` is a Google-signed OIDC token
 *      whose `email` claim matches `CLOUD_TASKS_INVOKER_SA_EMAIL`.
 *      Reject 401 on missing / malformed / wrong-issuer-email.
 *   2. Body validation — zod schema in snake_case wire format
 *      (matches the D.2 wire convention; transform to camelCase
 *      `ProvisioningTaskPayload` at the route boundary before
 *      calling the library function). Cloud Tasks delivers a
 *      base64-encoded JSON body; @hono/zod-validator decodes +
 *      validates in one step.
 *   3. Handler — `provisioningWorker(db, payload)` advances the
 *      state machine (REQUESTED → PROVISIONING → READY → ACTIVE
 *      per ALLOWED_TRANSITIONS + SA8 smoke test). Cloud Tasks
 *      retries on 5xx; 4xx terminal.
 *
 * Library function `provisioningWorker` is already implemented in
 * `@cortex/tenant-context/src/provisioning-worker.ts` (Slice A).
 * This route is the HTTP wrapper D.4.5 ships.
 */
import { provisioningWorker as defaultProvisioningWorker } from '@cortex/tenant-context';
import type { ProvisioningTaskPayload } from '@cortex/tenant-context';
import { zValidator } from '@hono/zod-validator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { AppConfig } from '../../config.js';
import { defaultOidcValidator, type OidcValidator } from './_shared/oidc.js';

/**
 * Wire-format body schema. Snake_case matches the D.2 convention +
 * `lifecycle-queue` payload pattern used elsewhere by `tenants.offboard`.
 * The library function takes camelCase `ProvisioningTaskPayload`;
 * the route handler transforms at the boundary.
 *
 * Strict — extra keys reject. Cloud Tasks dispatches under our
 * control; unrecognized keys signal a wire-format drift bug, not a
 * forward-compat opportunity.
 */
const provisioningBodySchema = z
  .object({
    tenant_id: z.string().uuid(),
    actor_type: z.enum(['service', 'user', 'system']),
    actor_id: z.string().min(1).max(255),
    actor_description: z.string().max(1024).optional(),
  })
  .strict();

export type ProvisioningWorkerFn = (
  db: ReturnType<typeof drizzle>,
  payload: ProvisioningTaskPayload,
) => Promise<void>;

export interface ProvisioningWorkerOptions {
  config: AppConfig;
  pool: Pool;
  /**
   * Inject a custom OIDC validator. Tests pass a stub; production
   * uses the default Google OAuth2Client-based validator.
   */
  validateOidc?: OidcValidator;
  /**
   * Inject a custom worker function. Tests pass a stub to assert
   * handler invocation without the full DB-side state machine
   * driving. Production uses `provisioningWorker` from
   * `@cortex/tenant-context`.
   */
  worker?: ProvisioningWorkerFn;
}

export function buildProvisioningWorkerRoutes(opts: ProvisioningWorkerOptions): Hono {
  const {
    config,
    pool,
    validateOidc = defaultOidcValidator,
    worker = defaultProvisioningWorker,
  } = opts;
  const app = new Hono();

  app.post(
    '/v1/_workers/provision',
    async (c, next): Promise<Response | void> => {
      const result = await validateOidc(
        c.req.header('authorization') ?? c.req.header('Authorization'),
        config.CLOUD_TASKS_INVOKER_SA_EMAIL,
      );
      if (!result.ok) {
        return c.json(
          {
            code: 'UNAUTHORIZED',
            message: `OIDC validation failed: ${result.reason ?? 'unknown'}`,
          },
          401,
        );
      }
      await next();
      return;
    },
    zValidator('json', provisioningBodySchema),
    async (c) => {
      const body = c.req.valid('json');
      // Snake_case wire → camelCase library payload.
      const payload: ProvisioningTaskPayload = {
        tenantId: body.tenant_id,
        actorType: body.actor_type,
        actorId: body.actor_id,
        ...(body.actor_description !== undefined && { actorDescription: body.actor_description }),
      };

      // No `withTenantDbClient` wrapper here. `provisioningWorker`
      // owns its own transaction boundaries — each state transition
      // runs in a fresh tx that binds `app.tenant_id` internally
      // (per provisioning-worker.ts SA11/SA13 design). Pass a plain
      // drizzle handle.
      const db = drizzle(pool);
      await worker(db, payload);

      // Worker returns void on success (idempotent no-op or
      // PROVISIONING → ACTIVE complete). Body is informational —
      // Cloud Tasks only reads the status code.
      return c.json({ tenant_id: body.tenant_id, status: 'processed' });
    },
  );

  return app;
}

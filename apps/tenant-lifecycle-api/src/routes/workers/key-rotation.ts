/**
 * Cloud Tasks worker route for tenant key rotation. Per Q-NEW-D-7:
 * lives on the same Cloud Run service as the user-facing API
 * (`tenant-lifecycle-shared`), under the `/v1/_workers/*` path
 * prefix that bypasses the user-tenant-context middleware.
 *
 * Pipeline:
 *   1. OIDC validation — verify the inbound `Authorization: Bearer`
 *      is a Google-signed OIDC token issued to the configured Cloud
 *      Tasks invoker SA per ADR-LIFECYCLE-001 §3. Reject 401 on
 *      missing / malformed / wrong-issuer-email tokens.
 *   2. Body validation — zod schema { tenant_id, trigger }. Cloud
 *      Tasks delivers a base64-encoded JSON payload; @hono/zod-
 *      validator decodes + validates in one step.
 *   3. Handler — `tenants.rotateKeys` against the validated body.
 *      Cloud Tasks retries on 5xx; a deliberate 4xx (404 not-found,
 *      409 wrong-status) terminates the retry loop.
 *
 * D.4 finalizes the OIDC validation (locks the invoker SA name +
 * audience to the TF-provisioned values) and wires the actual
 * `key-rotation-queue`. D.2 ships the receiver-side substrate;
 * dispatcher + queue are D.4.
 */
import { tenants, withTenantDbClient } from '@cortex/tenant-context';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { AppConfig } from '../../config.js';
import { defaultOidcValidator, type OidcValidator } from './_shared/oidc.js';

const keyRotationBodySchema = z.object({
  tenant_id: z.string().uuid(),
  trigger: z.enum(['scheduled', 'on_demand'] as const),
});

const WORKER_ACTOR = {
  type: 'service' as const,
  id: 'cortex-tenant-lifecycle-worker',
  description: 'Cloud Tasks worker for key rotation',
};

export interface KeyRotationWorkerOptions {
  config: AppConfig;
  pool: Pool;
  /**
   * Inject a custom OIDC validator. Tests pass a stub; production
   * uses the default Google OAuth2Client-based validator. D.4 may
   * extend this to support additional verification (e.g., audience
   * matching the Cloud Run service URL).
   */
  validateOidc?: OidcValidator;
}

export function buildKeyRotationWorkerRoutes(opts: KeyRotationWorkerOptions): Hono {
  const { config, pool, validateOidc = defaultOidcValidator } = opts;
  const app = new Hono();

  app.post(
    '/v1/_workers/key-rotation',
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
    zValidator('json', keyRotationBodySchema),
    async (c) => {
      const body = c.req.valid('json');
      const updated = await withTenantDbClient(pool, body.tenant_id, async (tx) =>
        tenants.rotateKeys(tx, body.tenant_id, { actor: WORKER_ACTOR }, { trigger: body.trigger }),
      );
      return c.json({
        tenant_id: updated.id,
        last_key_rotated_at: updated.last_key_rotated_at,
        status: updated.status,
      });
    },
  );

  return app;
}

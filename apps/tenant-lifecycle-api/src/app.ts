/**
 * Hono app factory. Composes middleware in the order:
 *   1. cold-start span — fires `recordColdStartOnce` on every request;
 *      first call per instance records the measurement.
 *   2. hono-pino — structured request logging via `@cortex/observability`'s
 *      logger (per ADR-HTTP-001 Condition 4).
 *   3. tenant-context — extracts `x-cortex-tenant-id` header and binds
 *      async-local store. Skipped for `/health` and `/v1/test/*`.
 *   4. routes — `/health`, `/v1/tenants/:id`, optional `/v1/test/slow-5s`.
 *   5. error handler — maps known errors to RFC 9457 problem-details
 *      via `hono-problem-details` (per ADR-HTTP-001 Condition 5).
 *
 * D.3 will swap step 3's skipPaths to include the broader test
 * surface and add per-route validation; D.1 ships only the minimal
 * composition needed to verify Conditions 2 + 3.
 */
import { buildTenantContextMiddleware } from '@cortex/tenant-context';
import { Hono } from 'hono';
import { problemDetailsHandler } from 'hono-problem-details';
import { pinoLogger } from 'hono-pino';
import type { Pool } from 'pg';

import type { AppConfig } from './config.js';
import { mapError } from './error-mapper.js';
import type { Telemetry } from './observability.js';
import { buildHealthRoutes } from './routes/health.js';
import { buildTestRoutes } from './routes/test.js';
import { buildV1TenantRoutes } from './routes/v1/tenants.js';
import { buildKeyRotationWorkerRoutes } from './routes/workers/key-rotation.js';

export function buildApp(args: { config: AppConfig; pool: Pool; telemetry: Telemetry }): Hono {
  const { config, pool, telemetry } = args;
  const app = new Hono();

  // Step 1: cold-start observation. Runs first so the measurement
  // window includes all subsequent middleware overhead.
  app.use('*', async (c, next) => {
    telemetry.recordColdStartOnce();
    await next();
  });

  // Step 2: structured request logger (hono-pino).
  app.use(
    '*',
    pinoLogger({
      pino: telemetry.logger,
    }),
  );

  // Step 3: tenant-context binding (header-based; from D.1). D.3's
  // user routes do NOT use this — they extract tenant_id from the
  // path parameter and bind via withTenantDbClient inline (per the
  // §7.1 Cloud SQL connection model + Q-NEW-D-8). The middleware
  // stays in place with rejectMissingTenant=false so a future caller
  // that DOES set x-cortex-tenant-id gets the binding for free, but
  // its absence is not a request-failure mode for the routes shipped
  // today. The worker route under /v1/_workers/* bypasses entirely
  // (its tenant_id flows from the Cloud Tasks payload).
  const tenantMw = buildTenantContextMiddleware({
    skipPaths: ['/health', '/v1/test/slow-5s', '/v1/_workers/key-rotation'],
    rejectMissingTenant: false,
  });
  app.use('*', (c, next) => tenantMw.hono(c, next));

  // Step 4: routes.
  app.route('/', buildHealthRoutes(config.COMMIT_SHA));
  app.route('/', buildV1TenantRoutes(pool));
  app.route('/', buildKeyRotationWorkerRoutes({ config, pool }));
  if (config.ENABLE_TEST_ROUTES) {
    app.route('/', buildTestRoutes());
  }

  // Step 5: error handler. Translates errors to RFC 9457
  // problem-details with workspace-extended fields per CLAUDE.md.
  // The library handler catches throws + falls back to a 500 envelope
  // for anything `mapError` returns `undefined` on. mapError's typed
  // extensions (`CortexProblemExtensions`) widen to the library's
  // generic `Record<string, unknown>` here.
  app.onError(
    problemDetailsHandler({
      mapError: (err) => mapError(err),
      autoInstance: true,
    }),
  );

  return app;
}

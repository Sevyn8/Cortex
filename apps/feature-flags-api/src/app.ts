/**
 * P1.6 Slice B — Hono app factory for `@cortex/feature-flags-api`.
 *
 * Per Q-NEW-FF-B-1 lock (e): this app is the **second apps-level
 * Hono service** in the workspace (first was `tenant-lifecycle-api`
 * shipped in F02 Slice D). The per-module-HTTP-service pattern is
 * NOT yet formalized — architectural review deferred to N=3.
 *
 * Middleware stack (matches `tenant-lifecycle-api` precedent shape;
 * minimal subset Slice B needs):
 *   1. tenant-context — extracts `x-cortex-tenant-id` header per
 *      Q-NEW-FF-B-3 lock (trust-the-header Phase 1; AC01 wires
 *      real auth in Phase 2).
 *   2. feature-flags route at `/v1/feature-flags`.
 *   3. error handler — RFC 9457 problem-details via `hono-problem-details`.
 *
 * Slice B deliberately omits: cold-start spans (P1.6 isn't
 * latency-budget-bound at this scale), structured request logging
 * (no logger dependency at this scope), Cloud SQL IAM auth (Phase 2
 * deployment concern; tests inject `Pool` directly). These can be
 * added at deploy-readiness time analogous to F02 Slice D's full app.
 */
import { buildTenantContextMiddleware } from '@cortex/tenant-context';
import { Hono } from 'hono';
import { problemDetailsHandler } from 'hono-problem-details';
import type { Pool } from 'pg';

import { mapError } from './error-mapper.js';
import { buildFeatureFlagsRoutes } from './routes/v1/feature-flags.js';

export interface AppDeps {
  pool: Pool;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Tenant-context middleware (header-based extraction). Skips
  // health check; otherwise rejects requests missing the header
  // (Q-NEW-FF-B-3 trust-the-header — AC01 swaps in real auth Phase 2).
  // TODO(AC01): replace `rejectMissingTenant: true` + header trust with
  // AC01 role-checking middleware when AC01 (P2.1) ships.
  const tenantMw = buildTenantContextMiddleware({
    skipPaths: ['/health'],
    rejectMissingTenant: true,
  });
  // Bind .hono to its method object to avoid `this`-scope warnings
  // when the function is detached from `tenantMw` (see
  // @typescript-eslint/unbound-method).
  app.use('*', tenantMw.hono.bind(tenantMw));

  // Health route (no tenant context needed).
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Feature-flags routes under /v1/feature-flags.
  app.route('/v1/feature-flags', buildFeatureFlagsRoutes(deps));

  // Problem-details handler — last-in-chain; catches errors thrown
  // by route handlers and middleware.
  app.onError(problemDetailsHandler({ mapError }));

  return app;
}

/**
 * F02 Slice D D.3 — user-facing HTTP API for tenant lifecycle.
 *
 * Surface (12 endpoints; per planning-doc SD7):
 *   GET    /v1/tenants                                — list (super-admin)
 *   POST   /v1/tenants                                — create (provision)
 *   GET    /v1/tenants/:id                            — read
 *   POST   /v1/tenants/:id/suspend                    — suspend
 *   POST   /v1/tenants/:id/resume                     — resume
 *   POST   /v1/tenants/:id/offboard                   — offboard
 *   POST   /v1/tenants/:id/terminate                  — terminate
 *   POST   /v1/tenants/:id/force-terminate            — force-terminate (super-admin)
 *   POST   /v1/tenants/:id/rotate-keys                — on-demand rotation
 *   POST   /v1/tenants/:id/legal-holds                — legalHolds.set
 *   DELETE /v1/tenants/:id/legal-holds/:hold_id       — legalHolds.release (idempotent; 204)
 *   POST   /v1/tenants/:id/approve-dedicated-db       — Q-OPEN-6 gate flip (super-admin)
 *
 * Per Q-NEW-D-8 + the §7.1 Cloud SQL connection model: every per-tenant
 * route binds via `withTenantDbClient(pool, id, fn)`. The buildTenant-
 * ContextMiddleware (header-based, from D.1) is configured with
 * `rejectMissingTenant: false` in app.ts so missing-header is a no-op
 * and routes do their own binding inline.
 *
 * Errors propagate to `app.onError(problemDetailsHandler({mapError}))`
 * which produces RFC 9457 problem-details with workspace-extended
 * fields per ADR-HTTP-001 Condition 5. The error-mapper from D.1
 * (src/error-mapper.ts) is the contract — see convention §7.4 for
 * the library-throw → HTTP-status table.
 *
 * Three super-admin endpoints (list / force-terminate /
 * approve-dedicated-db) are wrapped with `requireSuperAdmin()` — a
 * Phase 1 placeholder that always passes. Real super-admin enforcement
 * is the SD8 deny-by-default Cloud Run invoker IAM floor at the
 * platform layer; per-method gates land with AC01 (per planning-doc
 * D8 + future-roadmap §10.12). The placeholder marks the extension
 * point so AC01 can swap in the real check without rerouting handlers.
 */
import { zValidator } from '@hono/zod-validator';
import { legalHolds, tenants, withTenantDbClient, type Actor } from '@cortex/tenant-context';
import type { Storage } from '@google-cloud/storage';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────
// Phase 1 actor + super-admin guard
// ─────────────────────────────────────────────────────────────────────

/**
 * Phase 1 caller actor. Distinct from the worker's actor
 * (`cortex-tenant-lifecycle-worker`) so the audit chain can
 * disambiguate HTTP-initiated vs Cloud-Tasks-initiated lifecycle
 * events. AC01 will swap to a request-scoped actor resolver that
 * carries the authenticated user's id.
 */
const HTTP_ACTOR: Actor = {
  type: 'service',
  id: 'cortex-tenant-lifecycle-api',
  description: 'HTTP API caller (Phase 1 placeholder; AC01 swaps to per-request user actor)',
};

/**
 * Phase 1 super-admin guard. Per SD8 + Q-NEW-D-5: the floor is
 * Cloud Run invoker IAM (deny-by-default at the platform layer).
 * Per-method enforcement is AC01's job. This middleware exists so
 * the three super-admin routes (list / force-terminate /
 * approve-dedicated-db) have a single, named insertion point that
 * AC01 can replace without route-by-route surgery.
 */
const defaultSuperAdminGuard: MiddlewareHandler = async (_c, next) => {
  // TODO(AC01 / planning §10.12): replace with a real check that
  // reads the request-scoped actor + verifies super-admin role
  // membership. Phase 1 is a no-op placeholder — the actual
  // deny-by-default lives at Cloud Run's invoker IAM (SD8).
  await next();
};

// ─────────────────────────────────────────────────────────────────────
// Schemas (path params + body shapes)
// ─────────────────────────────────────────────────────────────────────

const idParamSchema = z.object({ id: z.string().uuid() });
const idAndHoldParamSchema = z.object({
  id: z.string().uuid(),
  hold_id: z.string().uuid(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createBodySchema = z.object({
  external_id: z.string().min(2).max(64),
  display_name: z.string().min(1).max(255),
  tier: z.enum(['STANDARD', 'ENTERPRISE']),
  initial_config: z.record(z.string(), z.unknown()).optional(),
});

const reasonBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

const offboardBodySchema = z.object({
  grace_period_days: z.number().int().min(1).max(365).optional(),
});

// Empty body (resume / terminate / rotate-keys). Validates that no
// extra keys are present — defensive parsing keeps the surface clean.
const emptyBodySchema = z.object({}).strict();

// legalHolds.set — discriminated union mirroring the library schema,
// in HTTP wire-format snake_case.
const legalHoldSetBodySchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('tenant'),
    reason: z.string().min(1).max(1000),
    set_by_user_id: z.string().min(1).max(255),
  }),
  z.object({
    scope: z.literal('record'),
    record_id: z.string().uuid(),
    reason: z.string().min(1).max(1000),
    set_by_user_id: z.string().min(1).max(255),
  }),
  z.object({
    scope: z.literal('data_class'),
    data_class: z.string().min(1).max(255),
    reason: z.string().min(1).max(1000),
    set_by_user_id: z.string().min(1).max(255),
  }),
]);

const legalHoldReleaseBodySchema = z
  .object({
    released_by_user_id: z.string().min(1).max(255),
    release_reason: z.string().min(1).max(1000).optional(),
  })
  .strict();

const forceTerminateBodySchema = z
  .object({
    reason: z.string().min(1).max(1000),
    override_metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const approveDedicatedDbBodySchema = z
  .object({
    approved_by_user_id: z.string().min(1).max(255),
    notes: z.string().max(2000).optional(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────
// Route builder
// ─────────────────────────────────────────────────────────────────────

export interface BuildV1TenantRoutesOptions {
  pool: Pool;
  /**
   * Inject an alternate super-admin guard. Tests pass a rejecting
   * stub to verify the guard IS in the request chain for the three
   * guarded endpoints. Production / default = no-op pass-through
   * (per Phase 1 SD8: deny-by-default lives at Cloud Run invoker IAM,
   * not at this middleware).
   */
  superAdminGuard?: MiddlewareHandler;
  /**
   * Test-only DI seam for the cascade workflows (offboard / terminate
   * / force-terminate) that touch GCS. Production omits — handlers
   * default-construct `new Storage()` per the existing library-layer
   * `cascadeOverrides` / `archiveOverrides` shape.
   *
   * One inbound shape (`storage`); two outbound mappings:
   *   - offboard's `tenants.offboard` consumes `archiveOverrides:
   *     { storage }` (export-archive uses `bucket().file().save()` +
   *     `getSignedUrl()`).
   *   - terminate + force-terminate consume `cascadeOverrides:
   *     { storage }` (cascade uses `bucket().deleteFiles({prefix})`).
   *
   * Tests construct an `inMemoryStorage()` fake (per `_helpers.ts`)
   * covering the surface both library functions exercise. D.4.5
   * HOLD-#2 reconciliation deferred this to D.6; landed here.
   */
  testHooks?: {
    storage?: Storage;
  };
}

export function buildV1TenantRoutes(arg: Pool | BuildV1TenantRoutesOptions): Hono {
  const opts: BuildV1TenantRoutesOptions = 'pool' in arg ? arg : { pool: arg };
  const { pool, superAdminGuard = defaultSuperAdminGuard, testHooks } = opts;
  const requireSuperAdmin = (): MiddlewareHandler => superAdminGuard;
  const app = new Hono();

  // ── GET /v1/tenants — list (super-admin) ───────────────────────────
  app.get('/v1/tenants', requireSuperAdmin(), zValidator('query', listQuerySchema), async (c) => {
    const { limit, offset } = c.req.valid('query');
    // No tenant binding — list is super-admin-scoped over the entire
    // tenant table (which has no RLS; control-plane registry).
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const db = drizzle(pool);
    const opts: { limit?: number; offset?: number } = {};
    if (limit !== undefined) opts.limit = limit;
    if (offset !== undefined) opts.offset = offset;
    const result = await tenants.list(db, opts);
    return c.json(result);
  });

  // ── POST /v1/tenants — create / provision ──────────────────────────
  app.post('/v1/tenants', zValidator('json', createBodySchema), async (c) => {
    const body = c.req.valid('json');
    // No tenant binding — the row doesn't exist yet. tenants.create
    // (called by tenants.provision) binds the new tenant_id mid-txn.
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const db = drizzle(pool);
    const created = await tenants.provision(
      db,
      {
        externalId: body.external_id,
        displayName: body.display_name,
        tier: body.tier,
        ...(body.initial_config !== undefined && { initialConfig: body.initial_config }),
      },
      { actor: HTTP_ACTOR },
    );
    // 202 Accepted: workflow runs async; caller polls GET /v1/tenants/:id
    // for status transitions (REQUESTED → PROVISIONING → READY → ACTIVE).
    // tenants.provision returns { tenantId, status } directly.
    return c.json({ tenant_id: created.tenantId, status: created.status }, 202);
  });

  // ── GET /v1/tenants/:id — read ────────────────────────────────────
  app.get('/v1/tenants/:id', zValidator('param', idParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const row = await withTenantDbClient(pool, id, async (tx) => tenants.get(tx, id));
    return c.json(row);
  });

  // ── POST /v1/tenants/:id/suspend ──────────────────────────────────
  app.post(
    '/v1/tenants/:id/suspend',
    zValidator('param', idParamSchema),
    zValidator('json', reasonBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { reason } = c.req.valid('json');
      const updated = await withTenantDbClient(pool, id, async (tx) =>
        tenants.suspend(tx, id, reason, { actor: HTTP_ACTOR }),
      );
      return c.json(updated);
    },
  );

  // ── POST /v1/tenants/:id/resume ───────────────────────────────────
  app.post(
    '/v1/tenants/:id/resume',
    zValidator('param', idParamSchema),
    zValidator('json', emptyBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const updated = await withTenantDbClient(pool, id, async (tx) =>
        tenants.resume(tx, id, { actor: HTTP_ACTOR }),
      );
      return c.json(updated);
    },
  );

  // ── POST /v1/tenants/:id/offboard ─────────────────────────────────
  app.post(
    '/v1/tenants/:id/offboard',
    zValidator('param', idParamSchema),
    zValidator('json', offboardBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const offboardOpts: Parameters<typeof tenants.offboard>[2] = {
        ...(body.grace_period_days !== undefined && {
          gracePeriodDays: body.grace_period_days,
        }),
        ...(testHooks?.storage !== undefined && {
          archiveOverrides: { storage: testHooks.storage },
        }),
      };
      const result = await withTenantDbClient(pool, id, async (tx) =>
        tenants.offboard(tx, id, offboardOpts, { actor: HTTP_ACTOR }),
      );
      return c.json({
        tenant: result.tenant,
        grace_until: result.graceUntil,
        export_archive: result.exportArchive,
      });
    },
  );

  // ── POST /v1/tenants/:id/terminate ────────────────────────────────
  app.post(
    '/v1/tenants/:id/terminate',
    zValidator('param', idParamSchema),
    zValidator('json', emptyBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      // tenants.terminate signature: (db, id, ctx, options). D.6 conflated
      // ctx + options into one bag (passed as ctx). With options defaulting
      // to {}, `cascadeOverrides.storage` was undefined and `new Storage()`
      // ran in the cascade, failing CI when GCP creds are absent.
      const terminateOptions: Parameters<typeof tenants.terminate>[3] =
        testHooks?.storage !== undefined
          ? { cascadeOverrides: { storage: testHooks.storage } }
          : {};
      const updated = await withTenantDbClient(pool, id, async (tx) =>
        tenants.terminate(tx, id, { actor: HTTP_ACTOR }, terminateOptions),
      );
      return c.json(updated);
    },
  );

  // ── POST /v1/tenants/:id/force-terminate (super-admin) ────────────
  app.post(
    '/v1/tenants/:id/force-terminate',
    requireSuperAdmin(),
    zValidator('param', idParamSchema),
    zValidator('json', forceTerminateBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      // forceTerminate signature: (db, id, reason, ctx, options). Same
      // D.6 conflation bug as terminate above; same fix.
      const forceTerminateOptions: Parameters<typeof tenants.forceTerminate>[4] =
        testHooks?.storage !== undefined
          ? { cascadeOverrides: { storage: testHooks.storage } }
          : {};
      const updated = await withTenantDbClient(pool, id, async (tx) =>
        tenants.forceTerminate(tx, id, body.reason, { actor: HTTP_ACTOR }, forceTerminateOptions),
      );
      return c.json(updated);
    },
  );

  // ── POST /v1/tenants/:id/rotate-keys — on-demand rotation ─────────
  // Per §7.4: caller-actor flows through (HTTP_ACTOR), NOT the
  // worker's hardcoded service actor. trigger='on_demand' bypasses
  // the 24-h cooldown.
  app.post(
    '/v1/tenants/:id/rotate-keys',
    zValidator('param', idParamSchema),
    zValidator('json', emptyBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const updated = await withTenantDbClient(pool, id, async (tx) =>
        tenants.rotateKeys(tx, id, { actor: HTTP_ACTOR }, { trigger: 'on_demand' }),
      );
      return c.json({
        tenant_id: updated.id,
        last_key_rotated_at: updated.last_key_rotated_at,
      });
    },
  );

  // ── POST /v1/tenants/:id/legal-holds — set ────────────────────────
  app.post(
    '/v1/tenants/:id/legal-holds',
    zValidator('param', idParamSchema),
    zValidator('json', legalHoldSetBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      // Translate snake_case wire shape → camelCase library shape.
      const libOpts =
        body.scope === 'tenant'
          ? {
              scope: 'tenant' as const,
              reason: body.reason,
              setByUserId: body.set_by_user_id,
            }
          : body.scope === 'record'
            ? {
                scope: 'record' as const,
                recordId: body.record_id,
                reason: body.reason,
                setByUserId: body.set_by_user_id,
              }
            : {
                scope: 'data_class' as const,
                dataClass: body.data_class,
                reason: body.reason,
                setByUserId: body.set_by_user_id,
              };
      const created = await withTenantDbClient(pool, id, async (tx) =>
        legalHolds.set(tx, id, libOpts, { actor: HTTP_ACTOR }),
      );
      return c.json(created, 201);
    },
  );

  // ── DELETE /v1/tenants/:id/legal-holds/:hold_id — release (204) ────
  app.delete(
    '/v1/tenants/:id/legal-holds/:hold_id',
    zValidator('param', idAndHoldParamSchema),
    zValidator('json', legalHoldReleaseBodySchema),
    async (c) => {
      const { id, hold_id } = c.req.valid('param');
      const body = c.req.valid('json');
      await withTenantDbClient(pool, id, async (tx) =>
        legalHolds.release(
          tx,
          id,
          hold_id,
          {
            releasedByUserId: body.released_by_user_id,
            ...(body.release_reason !== undefined && { releaseReason: body.release_reason }),
          },
          { actor: HTTP_ACTOR },
        ),
      );
      // 204 per REST convention for idempotent delete-style operations.
      // legalHolds.release is idempotent — re-calling on an already-
      // released hold is a no-op (no audit re-emit).
      return c.body(null, 204);
    },
  );

  // ── POST /v1/tenants/:id/approve-dedicated-db (super-admin) ────────
  app.post(
    '/v1/tenants/:id/approve-dedicated-db',
    requireSuperAdmin(),
    zValidator('param', idParamSchema),
    zValidator('json', approveDedicatedDbBodySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const updated = await withTenantDbClient(pool, id, async (tx) =>
        tenants.approveDedicatedDb(
          tx,
          id,
          { actor: HTTP_ACTOR },
          {
            approvedByUserId: body.approved_by_user_id,
            ...(body.notes !== undefined && { notes: body.notes }),
          },
        ),
      );
      return c.json(updated);
    },
  );

  return app;
}

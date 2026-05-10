/**
 * P1.6 Slice B — `GET /v1/feature-flags?userId=<userId>` route.
 *
 * Per Q-NEW-FF-B-2 lock: bulk fetch returns evaluation result for
 * every flag registered for the requesting tenant. Single round-trip;
 * client caches; periodic refresh per polling subscription.
 *
 * Tenant binding: the upstream `tenant-context` middleware (registered
 * in `app.ts`) extracts `x-cortex-tenant-id` and sets it in the async-
 * local store. This route reads it back via `getCurrentTenantId()` and
 * binds the pg session via `set_config('app.tenant_id', ...)` inside
 * a transaction so RLS-bound reads from `@cortex/feature-flags`'s
 * `evaluateAllFlags` succeed.
 *
 * Response shape:
 *   {
 *     flags: {
 *       "<flagKey>": { type: "boolean" | "variant" | "percentage";
 *                      value: boolean | string }
 *     }
 *   }
 *
 * Auth deferral note (Q-NEW-FF-B-3): trust-the-header in Phase 1.
 * AC01 (P2.1) will swap in role-checking middleware. Marked with
 * `// TODO(AC01)` in `app.ts`.
 */
import { evaluateAllFlags, type FlagEvaluation } from '@cortex/feature-flags';
import { getTenantId } from '@cortex/tenant-context';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { AppDeps } from '../../app.js';

const querySchema = z.object({
  userId: z.string().min(1).optional(),
});

export function buildFeatureFlagsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/', zValidator('query', querySchema), async (c) => {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      // Defense-in-depth — middleware should have rejected with
      // TenantContextMissingError already; this code path is
      // unreachable in practice but TypeScript exhaustiveness needs
      // the early-return.
      return c.json({ error: 'tenant context not bound' }, 500);
    }

    const { userId } = c.req.valid('query');
    const flags = await runWithBoundTenantClient(deps.pool, tenantId, (client) =>
      evaluateAllFlags(client, tenantId, userId),
    );
    return c.json({ flags });
  });

  return app;
}

/**
 * Open a pg client, begin a transaction, bind `app.tenant_id` for
 * RLS, run the callback, commit/rollback. The Queryable shape
 * (`PoolClient.query(sql, params)`) matches `@cortex/feature-flags`'s
 * `evaluateAllFlags` (which consumes F04's `getConfig` Queryable
 * surface).
 *
 * Inlined here for Slice B's narrow scope; if a second app-level
 * service needs the same pattern, extract to `@cortex/tenant-context`
 * as a production-named sibling of `withTenantContext` (currently
 * exported from `@cortex/canonical-schema/rls-test` for test use).
 */
async function runWithBoundTenantClient<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// Re-export for tests that want to assert on the response shape
// without re-deriving the type from the evaluator surface.
export interface FlagsBulkResponse {
  flags: Record<string, FlagEvaluation>;
}

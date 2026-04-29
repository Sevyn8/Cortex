import { zValidator } from '@hono/zod-validator';
import { tenants, withTenantDbClient } from '@cortex/tenant-context';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';

const idParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * GET /v1/tenants/{id} — D.1 surface.
 *
 * Wires the full request-scoped lifecycle: zod-validator on the path
 * parameter (Q-NEW-D-9 wiring exercise), withTenantDbClient for RLS
 * binding (Q-NEW-D-8), then `tenants.get` from the library. Errors
 * propagate through `app.onError(...)` → RFC 9457 problem-details.
 *
 * NOTE: D.1 does NOT use the buildTenantContextMiddleware skipPaths
 * pattern for /v1/tenants/{id} — the path's `id` IS the tenant id, so
 * the middleware's header-based extraction would force us to set
 * `x-cortex-tenant-id` redundantly. D.3 will codify the pattern; D.1
 * binds via withTenantDbClient directly per Q-NEW-D-8 resolution.
 */
export function buildTenantRoutes(pool: Pool): Hono {
  const app = new Hono();

  app.get('/v1/tenants/:id', zValidator('param', idParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const row = await withTenantDbClient(pool, id, async (tx) => tenants.get(tx, id));
    return c.json(row);
  });

  return app;
}

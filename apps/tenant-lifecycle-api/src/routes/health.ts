import { Hono } from 'hono';

/**
 * Liveness endpoint. No DB, no auth, no tenant context. Cloud Run
 * startup-probe + operator pings hit this; the buildTenantContextMiddleware
 * skipPaths list bypasses tenant binding for `/health`.
 */
export function buildHealthRoutes(commitSha: string): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      commit: commitSha,
    }),
  );

  return app;
}

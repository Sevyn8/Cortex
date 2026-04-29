import { Hono } from 'hono';

/**
 * D.1-only test routes for SD4 SIGTERM verification.
 *
 * Tag-gated behind ENABLE_TEST_ROUTES=true (which the deploy script
 * also gates on NODE_ENV !== 'production'). The route exists ONLY to
 * verify graceful shutdown per ADR-HTTP-001 Condition 3:
 *   1. Issue request to /v1/test/slow-5s.
 *   2. While in-flight (~3 s elapsed), trigger a Cloud Run revision
 *      update.
 *   3. Verify (a) original request returns 2xx within 10 s, (b) new
 *      revision serves new traffic, (c) no 503 / connection-reset.
 *
 * D.6 close commit removes this file or moves it permanently behind
 * a dev-only flag (decision deferred to D.6).
 */
export function buildTestRoutes(): Hono {
  const app = new Hono();

  app.get('/v1/test/slow-5s', async (c) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    return c.json({
      status: 'ok',
      slept_ms: 5_000,
      revision: process.env.K_REVISION ?? 'unknown',
    });
  });

  return app;
}

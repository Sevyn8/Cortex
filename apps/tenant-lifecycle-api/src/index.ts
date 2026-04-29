/**
 * Entry point for `apps/tenant-lifecycle-api`.
 *
 * Lifecycle:
 *   1. Module evaluation — `observability.ts` captures
 *      `PROCESS_START_HR` from `performance.now()` at import time.
 *      This is the earliest in-process marker we can stamp.
 *   2. `initTelemetry()` — starts the OTel SDK + creates logger /
 *      tracer / metrics. The OTLP exporter handshake happens here
 *      (lazy connection on first export, so init cost is small).
 *   3. `createPool(config)` — pg.Pool created but not yet connected;
 *      first DB query opens a connection.
 *   4. `serve(app, ...)` — `@hono/node-server` starts an HTTP listener.
 *      Once `listen` resolves, the instance is ready; subsequent first
 *      request fires `telemetry.recordColdStartOnce()` per SD3.
 *   5. SIGTERM handler — server.close() drains in-flight requests,
 *      then telemetry.shutdown() flushes OTLP. Total budget: 8 s
 *      (Cloud Run's grace is 10 s; SD4 reserves 2 s margin per the
 *      D.1 SIGTERM SOFT FAIL diagnostic).
 *
 * No business logic in this file — all lifts to `app.ts`.
 */
import { serve, type ServerType } from '@hono/node-server';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { initTelemetry } from './observability.js';

const SHUTDOWN_BUDGET_MS = 8_000; // SD4 reserves 2 s vs Cloud Run 10 s grace.

function main(): void {
  const config = loadConfig();
  const telemetry = initTelemetry();
  const pool = createPool(config);
  const app = buildApp({ config, pool, telemetry });

  const server: ServerType = serve({
    fetch: app.fetch.bind(app),
    port: config.PORT,
  });

  telemetry.logger.info(
    {
      port: config.PORT,
      revision: config.K_REVISION ?? 'unknown',
      commit: config.COMMIT_SHA,
      test_routes_enabled: config.ENABLE_TEST_ROUTES,
    },
    'tenant-lifecycle-api listening',
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    telemetry.logger.warn({ signal, budget_ms: SHUTDOWN_BUDGET_MS }, 'graceful shutdown initiated');

    // Hard-cap fallback: if anything stalls, exit before Cloud Run SIGKILLs us.
    const hardExit = setTimeout(() => {
      telemetry.logger.error(
        { signal, budget_ms: SHUTDOWN_BUDGET_MS },
        'shutdown budget exceeded; forcing exit',
      );
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);
    hardExit.unref();

    // Stop accepting new requests; drain in-flight.
    server.close((closeErr) => {
      const drainOk = closeErr === undefined;
      Promise.all([telemetry.shutdown(), pool.end()])
        .catch((flushErr: unknown) => {
          telemetry.logger.error({ err: flushErr }, 'shutdown flush failed');
        })
        .finally(() => {
          clearTimeout(hardExit);
          telemetry.logger.info({ signal, drain_ok: drainOk }, 'graceful shutdown complete');
          process.exit(drainOk ? 0 : 1);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (err: unknown) {
  // Pre-telemetry failure path — fall back to console.error.
  console.error('startup failed', err);
  process.exit(1);
}

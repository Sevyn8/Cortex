import { execSync } from 'node:child_process';
import { Pool } from 'pg';

/**
 * Build a `pg.Pool` from PG* env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/
 * PGDATABASE). PGPASSWORD MUST be set explicitly; an unset PGPASSWORD
 * is a setup error rather than something to paper over.
 *
 * Callers must ensure Postgres is reachable on the target host:port:
 *   - laptop: `make db:init-test` (boots compose Postgres + applies
 *     migrations + bootstraps test_user; mirrors CI shape).
 *   - CI: postgres service container per `.github/workflows/ci.yaml`.
 *   - elsewhere: PGHOST/PGPORT pointing at a reachable instance.
 *
 * Roadmap §4.20 closed 2026-05-09 by realigning compose Postgres to
 * the CI-shape (postgres/testpw/cortex). Prior gcloud-secret fallback
 * masked setup errors with a wrong-DB password — explicit error
 * replaces it.
 */
export function getPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error(
      'PGPASSWORD not set. Run `make db:init-test` to bootstrap the local ' +
        'test DB, or export PGPASSWORD=testpw if the compose stack is already ' +
        'running. CI sets PGPASSWORD via .github/workflows/ci.yaml services env.',
    );
  }

  const host = process.env.PGHOST ?? '127.0.0.1';
  const port = Number(process.env.PGPORT ?? 5432);

  // Reachability probe via Bash's /dev/tcp pseudo-device. No extra deps.
  try {
    execSync(`timeout 2 bash -c 'echo > /dev/tcp/${host}/${port}'`, {
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      `Postgres is not reachable on ${host}:${port}. ` +
        'If running locally, run `make db:init-test` first to bring up the compose stack. ' +
        'If running in CI, ensure the postgres service container is healthy. ' +
        'If running elsewhere, verify PGHOST/PGPORT env vars point at a reachable instance.',
    );
  }

  return new Pool({
    host,
    port,
    user: process.env.PGUSER ?? 'postgres',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

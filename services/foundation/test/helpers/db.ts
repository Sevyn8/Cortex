import { execSync } from 'node:child_process';
import { Pool } from 'pg';

/**
 * Creates a pg Pool from PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE env vars.
 * Defaults: 127.0.0.1:5432 / postgres / cortex. If PGPASSWORD is unset, falls
 * back to fetching the dev break-glass secret via gcloud (laptop convenience).
 *
 * Callers must ensure Postgres is reachable on the target host:port
 * (laptop: make db-proxy-dev; CI: postgres service container).
 */
export function getTestPool(): Pool {
  const password =
    process.env.PGPASSWORD ??
    execSync(
      'gcloud secrets versions access latest ' +
        '--secret=cortex-db-postgres-break-glass-dev ' +
        '--project=sevyn8-cortex-dev',
      { encoding: 'utf8' },
    ).trim();

  const host = process.env.PGHOST ?? '127.0.0.1';
  const port = Number(process.env.PGPORT ?? 5432);

  // Sanity-check: is Postgres actually reachable on host:port?
  // Bash's /dev/tcp pseudo-device lets us probe without extra deps.
  try {
    execSync(`timeout 2 bash -c 'echo > /dev/tcp/${host}/${port}'`, {
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      `Postgres is not reachable on ${host}:${port}. ` +
        'If running locally, ensure the Cloud SQL Auth Proxy is active (make db-proxy-dev). ' +
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

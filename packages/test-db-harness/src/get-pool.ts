import { execSync } from 'node:child_process';
import { Pool } from 'pg';

/**
 * Build a `pg.Pool` from PG* env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/
 * PGDATABASE). If PGPASSWORD is unset, falls back to fetching the dev
 * break-glass secret via `gcloud` for laptop convenience. Probes the
 * host:port via /dev/tcp to fail fast with a clear message if Postgres
 * isn't reachable.
 *
 * Callers must ensure Postgres is reachable on the target host:port:
 *   - laptop: `make db-proxy-dev` (cloud-sql-proxy on private IP per
 *     ADR-INFRA-005).
 *   - CI: postgres service container per `.github/workflows/ci.yaml`.
 *   - elsewhere: PGHOST/PGPORT pointing at a reachable instance.
 *
 * Local-DB credentials reconciliation tracked at future-roadmap §4.20
 * (carried across F02 D.4 / D.5 / D.4.5 / D.6 / F03 Slice A); CI's
 * ephemeral Postgres service container is the canonical exercise path.
 */
export function getPool(): Pool {
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

  // Reachability probe via Bash's /dev/tcp pseudo-device. No extra deps.
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

import { execSync } from 'node:child_process';
import { Pool } from 'pg';

/**
 * Creates a pg Pool connected to Cloud SQL dev via cloud-sql-proxy on 127.0.0.1.
 * Password is fetched from the break-glass secret via gcloud if PGPASSWORD is unset.
 *
 * Prereq: `make db-proxy-dev` running in a separate terminal.
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

  // Sanity-check: is cloud-sql-proxy actually up on the port?
  // Bash's /dev/tcp pseudo-device lets us probe without extra deps.
  try {
    execSync("timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/5432'", {
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      'cloud-sql-proxy is not running on 127.0.0.1:5432. ' +
        'Start it in a separate terminal with: make db-proxy-dev',
    );
  }

  return new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password,
    database: process.env.PGDATABASE ?? 'cortex',
  });
}

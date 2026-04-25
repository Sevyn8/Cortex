import { execSync } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';

/**
 * Build a `pg.Pool` from PG* env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/
 * PGDATABASE). If PGPASSWORD is unset, falls back to fetching the dev
 * break-glass secret via `gcloud` for local convenience. Probes the
 * host:port via /dev/tcp to fail fast with a clear message if the DB
 * isn't reachable.
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

  try {
    execSync(`timeout 2 bash -c 'echo > /dev/tcp/${host}/${port}'`, {
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      `Postgres is not reachable on ${host}:${port}. ` +
        'Set PGHOST/PGPORT to a reachable instance.',
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

/**
 * Run a callback inside a transaction with `app.tenant_id` bound. Used
 * for cleanup queries against RLS-protected tables — `test_user` is
 * NOSUPERUSER NOBYPASSRLS, so unbound DELETEs against
 * `tenant_config_version` etc. fail closed with 42501.
 */
export async function withBoundClient(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Idempotent ALTER TABLE audit_event FORCE ROW LEVEL SECURITY.
 *
 * `audit_event` is owned by `test_user` in the dev container; without
 * FORCE the owner bypasses RLS, which makes "RLS denies unbound writes"
 * tests silently pass. Intentionally NOT paired with an "unforce" — we
 * leave the FORCE state on so parallel test files can rely on the same
 * posture, matching the production runtime (where non-owner SAs are
 * naturally subject to RLS).
 */
export async function forceRlsOnAuditEvent(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE audit_event FORCE ROW LEVEL SECURITY`);
}

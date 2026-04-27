import { execSync } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bindTenantToDbSession } from '../../src/db-session.js';

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
 * Promise barrier with externally-callable resolve/reject. Standard
 * primitive for forcing transaction interleaving in two-connection
 * contention tests (Q-NEW-5; §10.15).
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Run two parallel transactions, each on its own pooled PoolClient
 * (independent connections), both auto-bound to the same `tenantId`.
 * Each callback receives a Drizzle `NodePgDatabase` transaction handle.
 *
 * Used for §10.15 contention testing: verify the row lock in
 * `setStatus` / `suspend` / `resume` actually serializes concurrent
 * UPDATE attempts. Tests use a `Deferred` barrier to force interleaving
 * (e.g., tx1 grabs the lock first, signals barrier, then tx2 attempts
 * to acquire the same lock — which must block at the DB until tx1
 * commits).
 *
 * Resolution returns `[result1, result2]` of both callbacks' return
 * values. If either transaction throws, that transaction rolls back
 * (Drizzle's `db.transaction` semantics) and the other still runs to
 * completion (errors don't abort the partner mid-flight); the helper
 * itself rejects with the first error observed via `Promise.all`.
 *
 * @param pool — shared `pg.Pool`.
 * @param tenantId — UUID; both transactions bind to this tenant via
 *   `bindTenantToDbSession`.
 * @param fn1 — first transaction callback; receives a bound tx handle.
 * @param fn2 — second transaction callback; receives a bound tx handle.
 */
export async function withTwoBoundClients<T1, T2>(
  pool: Pool,
  tenantId: string,
  fn1: (tx: NodePgDatabase<Record<string, never>>) => Promise<T1>,
  fn2: (tx: NodePgDatabase<Record<string, never>>) => Promise<T2>,
): Promise<[T1, T2]> {
  const client1 = await pool.connect();
  const client2 = await pool.connect();
  try {
    const db1 = drizzle(client1);
    const db2 = drizzle(client2);
    const txn1 = db1.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return fn1(tx);
    });
    const txn2 = db2.transaction(async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return fn2(tx);
    });
    return await Promise.all([txn1, txn2]);
  } finally {
    client1.release();
    client2.release();
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

import type { Pool, PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Run a callback inside a transaction on a single PoolClient. Generic
 * BEGIN / COMMIT / ROLLBACK lifecycle — no tenant-binding, no RLS
 * setup. Tenant-context callers wanting RLS-bound DELETEs layer their
 * own `bindTenantToDbSession(...)` inside `fn`.
 *
 * Replaces the duplicated `withBoundClient`-style helper across
 * services/foundation + packages/tenant-context.
 */
export async function withTransactionalClient(
  pool: Pool,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
 * Run two parallel transactions, each on its own pooled PoolClient
 * (independent connections), each with a Drizzle `NodePgDatabase`
 * transaction handle. Generic — no tenant-binding; callers shim per
 * their needs.
 *
 * Used for §10.15 contention testing: verify row locks actually
 * serialize concurrent UPDATE attempts. Pair with `deferred<T>()` to
 * force interleaving (e.g., tx1 grabs the lock + signals barrier;
 * tx2 attempts to acquire same lock + must block at the DB until tx1
 * commits).
 *
 * Resolution returns `[result1, result2]`. If either transaction
 * throws, that transaction rolls back (Drizzle `db.transaction`
 * semantics) and the other still runs to completion (errors don't
 * abort the partner mid-flight); the helper rejects with the first
 * error observed via `Promise.all`.
 */
export async function withTwoTransactions<T1, T2>(
  pool: Pool,
  fn1: (tx: NodePgDatabase<Record<string, never>>) => Promise<T1>,
  fn2: (tx: NodePgDatabase<Record<string, never>>) => Promise<T2>,
): Promise<[T1, T2]> {
  const client1 = await pool.connect();
  const client2 = await pool.connect();
  try {
    const db1 = drizzle(client1);
    const db2 = drizzle(client2);
    const txn1 = db1.transaction(fn1);
    const txn2 = db2.transaction(fn2);
    return await Promise.all([txn1, txn2]);
  } finally {
    client1.release();
    client2.release();
  }
}

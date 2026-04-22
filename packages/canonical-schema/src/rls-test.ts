import type { Pool, PoolClient } from 'pg';

type TxnFn<T> = (tx: PoolClient) => Promise<T>;

/**
 * Opens a transaction on `db`, issues `SET LOCAL app.tenant_id`, runs `fn`, commits.
 * Mirrors the F01 middleware contract (ADR-DB-002 §1).
 */
export async function withTenantContext<T>(db: Pool, tenantId: string, fn: TxnFn<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Opens a transaction with no tenant context. Use to exercise
 * `cortex.current_tenant_id()`'s fail-closed path (ADR-DB-002 §2).
 */
export async function withoutTenantContext<T>(db: Pool, fn: TxnFn<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

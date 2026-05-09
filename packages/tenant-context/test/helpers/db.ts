import type { Pool, PoolClient } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  getPool,
  withTransactionalClient,
  withTwoTransactions,
  forceRlsOnAuditEvent,
  deferred,
  type Deferred,
} from '@cortex/test-db-harness';
import { bindTenantToDbSession } from '../../src/db-session.js';

/**
 * Tenant-context test helper. Re-exports generic primitives from
 * `@cortex/test-db-harness` and adds tenant-binding shims that wrap
 * `bindTenantToDbSession` from this package's own `src/db-session.ts`
 * (extracting bind logic to the harness would create a cycle —
 * harness can't depend on tenant-context).
 *
 * Slim shape post F03 Slice B B.0 extraction.
 */

export { getPool, forceRlsOnAuditEvent, deferred, type Deferred };

/**
 * Tenant-bound BEGIN/COMMIT/ROLLBACK wrapper. Used for cleanup queries
 * against RLS-protected tables — `test_user` is NOSUPERUSER NOBYPASSRLS,
 * so unbound DELETEs against `tenant_config_version` etc. fail closed
 * with 42501. Wraps the harness's `withTransactionalClient` + binds
 * `app.tenant_id` inside the transaction.
 */
export async function withBoundClient(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  return withTransactionalClient(pool, async (client) => {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await fn(client);
  });
}

/**
 * Tenant-bound two-transaction helper. Wraps the harness's
 * `withTwoTransactions` and binds `app.tenant_id` inside each via
 * `bindTenantToDbSession`. See harness doc for contention-testing
 * rationale.
 */
export async function withTwoBoundClients<T1, T2>(
  pool: Pool,
  tenantId: string,
  fn1: (tx: NodePgDatabase<Record<string, never>>) => Promise<T1>,
  fn2: (tx: NodePgDatabase<Record<string, never>>) => Promise<T2>,
): Promise<[T1, T2]> {
  return withTwoTransactions(
    pool,
    async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return fn1(tx);
    },
    async (tx) => {
      await bindTenantToDbSession(tx, tenantId);
      return fn2(tx);
    },
  );
}

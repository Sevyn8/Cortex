/**
 * `@cortex/test-db-harness` — shared DB harness for workspace tests.
 *
 * Extracted at F03 Slice B B.0 from two duplicate test/helpers/db.ts
 * files (services/foundation + packages/tenant-context). Per
 * Q-NEW-F03B-2 lock: workspace packages SHOULD NOT centralize fixtures
 * under services/foundation/test/; shared utilities go here.
 *
 * Exports:
 *   - getPool() — pg.Pool from PG* env vars (gcloud break-glass fallback;
 *     /dev/tcp probe). Used in CI (postgres service container) + locally
 *     (cloud-sql-proxy). The local-DB credentials reconciliation is
 *     tracked at future-roadmap §4.20; carries forward.
 *   - withTransactionalClient(pool, fn) — generic BEGIN/COMMIT/ROLLBACK
 *     wrapper around a single PoolClient. No tenant-binding; callers
 *     that need RLS-bound DELETEs layer their own bind logic on top
 *     (tenant-context's test/helpers/db.ts ships withBoundClient as a
 *     thin shim).
 *   - withTwoTransactions(pool, fn1, fn2) — two parallel transactions on
 *     independent PoolClients. Receives drizzle handles. Used for
 *     contention testing (§10.15 row-lock invariants). Generic — no
 *     tenant-binding; callers shim per their needs.
 *   - forceRlsOnAuditEvent(pool) — idempotent ALTER TABLE FORCE RLS on
 *     audit_event. Required for tests where test_user (table owner in
 *     CI) would otherwise bypass RLS.
 *   - Deferred / deferred() — promise barrier with externally-callable
 *     resolve/reject. Concurrency-test primitive.
 */
export { getPool } from './get-pool.js';
export { withTransactionalClient, withTwoTransactions } from './transactions.js';
export { forceRlsOnAuditEvent } from './force-rls.js';
export { deferred, type Deferred } from './deferred.js';

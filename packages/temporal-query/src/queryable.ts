/**
 * Generic query interface accepting `(sql, params) → { rows }`. Per
 * Q-NEW-F03B-5 (productization-critical lock at Slice B HOLD #1):
 * `@cortex/temporal-query`'s public API does NOT import `pg.Pool`
 * directly — consumers pass anything that satisfies this shape:
 *
 *   - `pg.Pool.query(...)` ✓ (returns `pg.QueryResult<T>` whose `rows`
 *     field satisfies `unknown[]`)
 *   - `pg.PoolClient.query(...)` ✓ (same shape)
 *   - drizzle's `client.query(...)` (the underlying `pg` client) ✓
 *   - test mocks ✓
 *
 * Adding tRPC / hosted-RPC / proxied DB clients later — they all
 * satisfy `Queryable` with at most a thin shim.
 */
export interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

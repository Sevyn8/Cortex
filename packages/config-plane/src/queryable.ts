/**
 * Generic query interface accepting `(sql, params) → { rows }`.
 * Mirrors `@cortex/temporal-query`'s `Queryable` precedent — keeps
 * F04's public API independent of `pg.Pool` so consumers can pass
 * any of: `pg.Pool`, `pg.PoolClient`, drizzle's underlying client,
 * test mocks. Same productization-critical shape (Q-NEW-F03B-5
 * established the precedent; F04 follows).
 */
export interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

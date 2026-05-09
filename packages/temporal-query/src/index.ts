/**
 * `@cortex/temporal-query` — TS library wrapping `cortex.at_time_t`.
 *
 * Five composable functions over the bi-temporal substrate (ADR-DB-001
 * + migrations 0002 / 0006):
 *   - asOf         — single row matching id at given (validTs, sysTs?)
 *   - currentState — single row matching id with open txn_time
 *   - history      — all rows matching id, ordered by lower(txn_time)
 *   - between      — rows matching id with valid_time && [from, to)
 *   - diff         — { before, after, changedColumns } across two times
 *
 * Public API takes a `Queryable` interface (Q-NEW-F03B-5) — pg.Pool,
 * pg.PoolClient, drizzle's underlying client, test mocks all satisfy
 * it. No direct `pg` import in the public surface.
 *
 * Locks (per docs/planning/f03-slice-A-scope.md → operator B-locks):
 *   D7 — new package (not extension of canonical-schema)
 *   D8 — string-wire pass-through (Date → tstzrange wire)
 *   Q-NEW-F03B-3 — closed-open [from, to) ranges
 *   Q-NEW-F03B-4 — nullable returns; no throw-on-empty
 *   Q-NEW-F03B-5 — Queryable interface
 *   Q-NEW-F03B-6 — explicit tenantId on every function
 *   Q-NEW-F03B-7 — diff returns { before, after, changedColumns }
 *
 * Deferred to first-consumer (per Q-NEW-F03B-1 → D3):
 *   - tRPC handlers → @cortex/temporal-query/trpc secondary export
 *   - SQL views → per-table at consuming F-/D-series migration site
 */
export { asOf } from './as-of.js';
export { currentState } from './current-state.js';
export { history } from './history.js';
export { between } from './between.js';
export { diff, type Diff } from './diff.js';
export { type Queryable } from './queryable.js';

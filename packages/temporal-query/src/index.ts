/**
 * `@cortex/temporal-query` — TS library wrapping `cortex.at_time_t`.
 *
 * Composable functions over the bi-temporal substrate (ADR-DB-001 +
 * migrations 0002 / 0006):
 *
 *   Row-version (id-based):
 *     - asOf         — single row matching id at (validTs, sysTs?)
 *     - currentState — single row matching id with open txn_time
 *     - history      — all rows matching id, ordered by lower(txn_time)
 *     - between      — rows matching id with valid_time && [from, to)
 *     - diff         — { before, after, changedColumns } across two
 *                      times (@experimental — see diffByKey for the
 *                      entity-level use case)
 *
 *   Entity-level (business-key-based; F03 Slice B.5):
 *     - asOfByKey    — single row matching (tenant_id, keyColumn = key)
 *     - diffByKey    — { before, after, changedColumns } across two
 *                      times via business identity (the headline F03
 *                      "what changed about this product" use case)
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
 * Slice B.5 locks (D9-D16; see docs/planning/f03-slice-B5-scope.md):
 *   D9  — function pair (asOfByKey + diffByKey)
 *   D10 — diffByKey defaults SYMMETRIC (t, t) per anchor — historical-
 *         snapshot mode; CRITICAL asymmetry vs row-version diff which
 *         defaults systemAnchor=now
 *   D11 — keyColumn validated identically to table (validateIdentifier)
 *   D12 — keyValue: string | number; composite keys deferred
 *   D13 — multiple-row match throws (substrate violation; loud failure)
 *   D14 — diffByKey EXCLUDED includes keyColumn dynamically
 *
 * Deferred to first-consumer (per Q-NEW-F03B-1 → D3):
 *   - tRPC handlers → @cortex/temporal-query/trpc secondary export
 *   - SQL views → per-table at consuming F-/D-series migration site
 */
export { asOf } from './as-of.js';
export { asOfByKey } from './as-of-by-key.js';
export { currentState } from './current-state.js';
export { history } from './history.js';
export { between } from './between.js';
export { diff, type Diff } from './diff.js';
export { diffByKey, type DiffByKey } from './diff-by-key.js';
export { type Queryable } from './queryable.js';
export {
  SCDPolicySchema,
  SCDEntityPolicySchema,
  SCD_POLICY_NAMESPACE,
  SCD_POLICY_SCHEMA_VERSION,
  type SCDPolicy,
  type SCDEntityPolicy,
} from './scd-policy.js';

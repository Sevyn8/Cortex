import type { BiTemporalRow } from '@cortex/canonical-schema';
import type { Queryable } from './queryable.js';
import { asOfByKey } from './as-of-by-key.js';

/**
 * Excluded columns from `changedColumns` computation. Same base list
 * as `diff` (`id`, `tenant_id`, `valid_time`, `txn_time`) PLUS the
 * caller-supplied `keyColumn` per Slice B.5 D14 — the business key is
 * tautologically unchanged (we looked up both rows by that exact
 * value). Including it would clutter every entity-level diff with a
 * stale "key changed" report.
 */
const BASE_EXCLUDED: ReadonlySet<string> = new Set(['id', 'tenant_id', 'valid_time', 'txn_time']);

export interface DiffByKey<T> {
  before: BiTemporalRow<T> | null;
  after: BiTemporalRow<T> | null;
  changedColumns: (keyof T)[];
}

/**
 * Diff the entity identified by `(tenantId, <keyColumn> = keyValue)`
 * between two timestamps. Entity-level — follows the SCD chain by
 * business key — distinct from `diff` which is row-version scoped.
 *
 * **CRITICAL** (Slice B.5 D10): `t1` and `t2` are each treated as
 * BOTH the business AND system anchor when calling `asOfByKey`. This
 * is HISTORICAL-SNAPSHOT semantics — "what did the system know at t1
 * about the world at t1?" — which is the natural shape for the
 * headline F03 "what changed about this product over time" use case.
 *
 * This is **deliberately ASYMMETRIC** with row-version `diff`, which
 * defaults each anchor's system axis to `now()`. The asymmetry is
 * documented in JSDoc + CLAUDE.md "Querying bi-temporal data". The
 * row-version `diff`'s default-to-now is what produced the F03 spec
 * acceptance test bug closed in commit `a7c9a23`; `diffByKey`'s
 * default avoids that surprise structurally.
 *
 * Returns `{ before, after, changedColumns }`:
 *   - `before` / `after` may be `null` independently per
 *     Q-NEW-F03B-7 — the entity might not have existed at one
 *     timestamp.
 *   - `changedColumns` excludes `id`, `tenant_id`, `valid_time`,
 *     `txn_time` (rotated/scoping/bookkeeping) AND the
 *     `keyColumn` itself (tautologically equal across both
 *     lookups).
 *   - When either side is `null`, `changedColumns` is the union of
 *     non-excluded keys present in the non-null side.
 *   - When both are `null`, `changedColumns` is `[]`.
 *
 * Implementation: two `asOfByKey` calls + a shallow-equality scan.
 * No special-case SQL — substrate already preserves all versions;
 * `asOfByKey` finds the right one for each anchor.
 */
export async function diffByKey<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  keyColumn: string,
  keyValue: string | number,
  t1: Date,
  t2: Date,
): Promise<DiffByKey<T>> {
  // Symmetric (business, system) per Slice B.5 D10 — pass each anchor
  // as BOTH the business AND system axis. Distinct from row-version
  // `diff`'s system-default = now().
  const [before, after] = await Promise.all([
    asOfByKey<T>(client, tenantId, table, keyColumn, keyValue, t1, t1),
    asOfByKey<T>(client, tenantId, table, keyColumn, keyValue, t2, t2),
  ]);

  const excluded = new Set<string>(BASE_EXCLUDED);
  excluded.add(keyColumn);

  const changedColumns = computeChangedColumns<T>(before, after, excluded);
  return { before, after, changedColumns };
}

function computeChangedColumns<T>(
  before: BiTemporalRow<T> | null,
  after: BiTemporalRow<T> | null,
  excluded: ReadonlySet<string>,
): (keyof T)[] {
  if (before === null && after === null) return [];

  const keys = new Set<string>();
  if (before !== null) {
    for (const k of Object.keys(before)) {
      if (!excluded.has(k)) keys.add(k);
    }
  }
  if (after !== null) {
    for (const k of Object.keys(after)) {
      if (!excluded.has(k)) keys.add(k);
    }
  }

  if (before === null || after === null) {
    return Array.from(keys) as (keyof T)[];
  }

  const beforeRec = before as unknown as Record<string, unknown>;
  const afterRec = after as unknown as Record<string, unknown>;
  const changed: string[] = [];
  for (const k of keys) {
    if (beforeRec[k] !== afterRec[k]) {
      changed.push(k);
    }
  }
  return changed as (keyof T)[];
}

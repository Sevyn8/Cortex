import type { BiTemporalRow } from '@cortex/canonical-schema';
import type { Queryable } from './queryable.js';
import { asOf } from './as-of.js';

/**
 * Excluded columns from `changedColumns` computation. Documented inline
 * per Slice B HOLD #1 sub-decision 2:
 *
 *   - `id` rotates per SCD version (migration 0002 trigger:
 *     `NEW.id := gen_random_uuid()`), so it's row-version identity.
 *     Including it would make every diff tautologically report
 *     id-changed.
 *   - `tenant_id` is universal scoping, never an entity-level domain
 *     change.
 *   - `valid_time` / `txn_time` are SCD bookkeeping by recipe.
 *
 * Business-key columns (e.g., `external_sku`, `business_key`) are NOT
 * excluded. The library cannot know per-table which column is the
 * business key; caller can post-filter `changedColumns` if needed.
 */
const EXCLUDED: ReadonlySet<string> = new Set(['id', 'tenant_id', 'valid_time', 'txn_time']);

export interface Diff<T> {
  before: BiTemporalRow<T> | null;
  after: BiTemporalRow<T> | null;
  changedColumns: (keyof T)[];
}

/**
 * Diff the entity identified by `(tenantId, id)` between two
 * timestamps `t1` and `t2`. Per Q-NEW-F03B-7:
 *
 *   - `before` / `after` may be `null` independently — the entity
 *     might not have existed at one timestamp.
 *   - `changedColumns` lists shallow-equality-different keys across
 *     non-temporal columns (excludes `id`, `tenant_id`, `valid_time`,
 *     `txn_time`).
 *   - When either side is `null`, `changedColumns` is the union of
 *     non-excluded keys present in the non-null side (every column
 *     "changed" by virtue of appearing / disappearing).
 *   - When both are `null`, `changedColumns` is `[]`.
 *
 * Implemented as two `asOf` calls + a shallow-equality scan. No
 * special-case SQL — the SCD substrate already preserves all versions;
 * `asOf` finds the right one for each anchor.
 */
export async function diff<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  id: string,
  t1: Date,
  t2: Date,
): Promise<Diff<T>> {
  const [before, after] = await Promise.all([
    asOf<T>(client, tenantId, table, id, t1),
    asOf<T>(client, tenantId, table, id, t2),
  ]);

  const changedColumns = computeChangedColumns<T>(before, after);
  return { before, after, changedColumns };
}

function computeChangedColumns<T>(
  before: BiTemporalRow<T> | null,
  after: BiTemporalRow<T> | null,
): (keyof T)[] {
  if (before === null && after === null) return [];

  const keys = new Set<string>();
  if (before !== null) {
    for (const k of Object.keys(before)) {
      if (!EXCLUDED.has(k)) keys.add(k);
    }
  }
  if (after !== null) {
    for (const k of Object.keys(after)) {
      if (!EXCLUDED.has(k)) keys.add(k);
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

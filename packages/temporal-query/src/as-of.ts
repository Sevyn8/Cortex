import type { BiTemporalRow } from '@cortex/canonical-schema';
import type { Queryable } from './queryable.js';
import { mapRow } from './_internals/deserialize.js';
import { validateTableName } from './_internals/validate-table.js';

/**
 * Return the row identified by `(tenantId, id)` whose temporal state
 * contains both anchors. Per Q-NEW-F03B-4: nullable return — if no row
 * matches the predicate (entity didn't exist at the anchors, or the
 * row's valid_time / txn_time excluded the anchors), returns `null`
 * rather than throwing.
 *
 * - `asOfBusinessTs` — the valid-time anchor (the "what was true in
 *   the business world at this moment" question).
 * - `asOfSystemTs` — optional transaction-time anchor (the "what did
 *   the system know at this moment" question). Defaults to `now()` —
 *   "what does the system currently believe was true at
 *   asOfBusinessTs?"
 *
 * Per Q-NEW-F03B-6: `tenantId` is passed as a query parameter, NOT
 * relied on via session-level `app.tenant_id`. RLS stays as
 * defense-in-depth backstop, not primary enforcement.
 */
export async function asOf<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  id: string,
  asOfBusinessTs: Date,
  asOfSystemTs?: Date,
): Promise<BiTemporalRow<T> | null> {
  validateTableName(table);
  const sql = `
    SELECT *
    FROM ${table}
    WHERE id = $1
      AND tenant_id = $2
      AND cortex.at_time_t(valid_time, txn_time, $3, $4)
    LIMIT 1
  `;
  const sysAnchor = asOfSystemTs ?? new Date();
  const result = await client.query(sql, [id, tenantId, asOfBusinessTs, sysAnchor]);
  if (result.rows.length === 0) return null;
  return mapRow<T>(result.rows[0] as Record<string, unknown>);
}

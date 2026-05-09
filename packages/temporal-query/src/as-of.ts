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
 *
 * The two queries the asymmetric default supports — note carefully that
 * the SCD trigger (migration 0002) closes prior-version rows by setting
 * their `txn_time` upper bound. The default-to-now system-anchor reaches
 * only the OPEN current row for any given id; closed prior versions
 * require an explicit past system-anchor.
 *
 * @example Current-belief query (default systemAnchor = now())
 * ```ts
 * // "What does the system currently believe was true at businessTs?"
 * // Reaches only the row whose txn_time is currently OPEN — i.e.,
 * // the system's latest knowledge for this id. If the id was closed
 * // by a prior SCD update, this returns null (current knowledge is
 * // carried by a different id, since the trigger rotates id).
 * const row = await asOf(client, tenantId, 'product', id, businessTs);
 * ```
 *
 * @example Historical-snapshot query (explicit systemAnchor)
 * ```ts
 * // "What did the system believe at systemTs about businessTs?"
 * // Reaches a CLOSED prior version when systemTs falls inside that
 * // version's txn_time range — e.g., to recover a row's pre-update
 * // state before the SCD trigger fired. systemTs == businessTs is
 * // the common shape for "what was the world state at moment T".
 * const row = await asOf(
 *   client, tenantId, 'product', id, businessTs, systemTs,
 * );
 * ```
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

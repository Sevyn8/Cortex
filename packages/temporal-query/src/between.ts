import type { BiTemporalRow } from '@cortex/canonical-schema';
import type { Queryable } from './queryable.js';
import { mapRows } from './_internals/deserialize.js';
import { validateIdentifier } from './_internals/validate-identifier.js';
import { serializeTstzRange } from './_internals/serialize.js';

/**
 * Return all rows matching `(tenantId, id)` whose valid_time
 * intersects the half-open business-time range `[from, to)` AND whose
 * txn_time contains the system-time anchor (defaults to `now()`).
 *
 * Per Q-NEW-F03B-3 (closed-open lock): the range is `[from, to)` — the
 * lower bound inclusive, the upper exclusive — matching tstzrange
 * convention end-to-end. No closed-closed translation at the TS layer.
 *
 * Implemented via `&&` (range overlap). `serializeTstzRange` produces
 * `[from,to)` wire format for the parameterized cast.
 *
 * Per Q-NEW-F03B-4: returns `[]` (never null) if no rows match.
 * Per Q-NEW-F03B-6: `tenantId` as query parameter.
 */
export async function between<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  id: string,
  from: Date,
  to: Date,
  asOfSystemTs?: Date,
): Promise<BiTemporalRow<T>[]> {
  validateIdentifier(table, 'table');
  const rangeWire = serializeTstzRange(from, to);
  const sysAnchor = asOfSystemTs ?? new Date();
  const sql = `
    SELECT *
    FROM ${table}
    WHERE id = $1
      AND tenant_id = $2
      AND valid_time && $3::tstzrange
      AND txn_time @> $4::timestamptz
    ORDER BY lower(valid_time) ASC
  `;
  const result = await client.query(sql, [id, tenantId, rangeWire, sysAnchor]);
  return mapRows<T>(result.rows);
}

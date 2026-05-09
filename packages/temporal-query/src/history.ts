import type { BiTemporalRow } from '@cortex/canonical-schema';
import type { Queryable } from './queryable.js';
import { mapRows } from './_internals/deserialize.js';
import { validateIdentifier } from './_internals/validate-identifier.js';

/**
 * Return all rows matching `(tenantId, id)` ordered by transaction-
 * time ascending — the row's full history. Per Q-NEW-F03B-4: returns
 * `[]` (never null) if no row matches.
 *
 * Notes on SCD-rotated `id` semantics: per migration 0002's trigger,
 * `id` is a row-version PK that rotates on every UPDATE. So
 * `history(id)` returns AT MOST ONE row — the row's own creation +
 * any later closure metadata. To trace an entity across SCD versions,
 * a higher-level "follow the chain via business_key" wrapper would
 * sit on top of this primitive (out of Slice B scope; first-consumer-
 * driven per ADR-DB-001 deferral pattern).
 *
 * Per Q-NEW-F03B-6: `tenantId` as query parameter; RLS as backstop.
 */
export async function history<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  id: string,
): Promise<BiTemporalRow<T>[]> {
  validateIdentifier(table, 'table');
  const sql = `
    SELECT *
    FROM ${table}
    WHERE id = $1
      AND tenant_id = $2
    ORDER BY lower(txn_time) ASC
  `;
  const result = await client.query(sql, [id, tenantId]);
  return mapRows<T>(result.rows);
}

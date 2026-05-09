import type { BiTemporalRow } from '@cortex/canonical-schema';
import type { Queryable } from './queryable.js';
import { mapRow } from './_internals/deserialize.js';
import { validateIdentifier } from './_internals/validate-identifier.js';

/**
 * Return the current-version row identified by `(tenantId, id)` —
 * the row whose `txn_time` is open (`upper(txn_time) IS NULL`). Per
 * Q-NEW-F03B-4: returns `null` if no current-version row matches
 * (entity was logically deleted, or the id refers to a closed prior
 * version).
 *
 * Hot-path query — relies on the per-table tenant_current partial
 * index (`<table>_tenant_current ON (tenant_id) WHERE upper(txn_time)
 * IS NULL`) emitted by Slice A's scaffold.
 *
 * Per Q-NEW-F03B-6: `tenantId` as query parameter; RLS as backstop.
 */
export async function currentState<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  id: string,
): Promise<BiTemporalRow<T> | null> {
  validateIdentifier(table, 'table');
  const sql = `
    SELECT *
    FROM ${table}
    WHERE id = $1
      AND tenant_id = $2
      AND upper(txn_time) IS NULL
    LIMIT 1
  `;
  const result = await client.query(sql, [id, tenantId]);
  if (result.rows.length === 0) return null;
  return mapRow<T>(result.rows[0] as Record<string, unknown>);
}

import type { BiTemporalRow } from '@cortex/canonical-schema';
import type { Queryable } from './queryable.js';
import { mapRow } from './_internals/deserialize.js';
import { validateIdentifier } from './_internals/validate-identifier.js';

/**
 * Return the row whose `(tenantId, <keyColumn> = keyValue)` business
 * identity resolves at both temporal anchors. Entity-level lookup —
 * follows the SCD chain by business key, NOT row-version id.
 *
 * Companion to `asOf` (id-based). The pair exists because the SCD
 * trigger (migration 0002) rotates `id` on UPDATE
 * (`NEW.id := gen_random_uuid()`), so id-based lookup can't reach
 * across versions for "what was this entity at T". `asOfByKey`
 * resolves the entity at each timestamp via the business identity.
 *
 * - `asOfBusinessTs` — valid-time anchor.
 * - `asOfSystemTs` — optional transaction-time anchor; defaults to
 *   `now()` (matches `asOf`'s asymmetric default; pass an explicit
 *   past anchor to retrieve closed prior versions).
 *
 * Composite (multi-column) business keys are out of scope by Slice
 * B.5 D12 — `keyValue` is `string | number`. Most bi-temporal
 * entities have single-column business keys (sku, customer_id,
 * order_number, etc.). Multi-column composite-key support deferred
 * to first-consumer per ADR-DB-001 deferral pattern.
 *
 * Per Slice B.5 D13: this query runs WITHOUT `LIMIT 1`. If multiple
 * rows match (which the substrate's exclusion constraint should make
 * impossible for currently-open rows but doesn't prevent for closed
 * historical overlaps), the function throws with an explicit error
 * pointing at the substrate constraint violation. Loud failure beats
 * non-deterministic row selection — exposes upstream SCD bugs rather
 * than masking them.
 *
 * @example Current-belief query (default systemAnchor = now())
 * ```ts
 * const row = await asOfByKey<Product>(
 *   client, tenantId, 'product', 'sku', 'WIDGET-1', businessTs,
 * );
 * ```
 *
 * @example Historical-snapshot query (explicit systemAnchor)
 * ```ts
 * // "What did the system believe at systemTs about businessTs?"
 * // For closed prior versions, systemTs typically equals businessTs.
 * const row = await asOfByKey<Product>(
 *   client, tenantId, 'product', 'sku', 'WIDGET-1', businessTs, systemTs,
 * );
 * ```
 */
export async function asOfByKey<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  keyColumn: string,
  keyValue: string | number,
  asOfBusinessTs: Date,
  asOfSystemTs?: Date,
): Promise<BiTemporalRow<T> | null> {
  validateIdentifier(table, 'table');
  validateIdentifier(keyColumn, 'column');
  const sql = `
    SELECT *
    FROM ${table}
    WHERE tenant_id = $1
      AND ${keyColumn} = $2
      AND cortex.at_time_t(valid_time, txn_time, $3, $4)
  `;
  const sysAnchor = asOfSystemTs ?? new Date();
  const result = await client.query(sql, [tenantId, keyValue, asOfBusinessTs, sysAnchor]);
  if (result.rows.length === 0) return null;
  if (result.rows.length > 1) {
    throw new Error(
      `temporal-query: multiple rows match (tenant_id=${JSON.stringify(tenantId)}, ` +
        `${keyColumn}=${JSON.stringify(keyValue)}) at ` +
        `businessTs=${asOfBusinessTs.toISOString()} systemTs=${sysAnchor.toISOString()} — ` +
        `substrate constraint violation; check SCD exclusion constraint on ${table}.`,
    );
  }
  return mapRow<T>(result.rows[0] as Record<string, unknown>);
}

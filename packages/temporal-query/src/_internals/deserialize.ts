/**
 * Wire-format → BiTemporalRow<T> deserialization helper.
 *
 * Postgres returns tstzrange columns as wire-format strings (e.g.,
 * `["2026-04-22 10:00:00+00",)`). The library reads them via
 * `parseTstzRange` from `@cortex/canonical-schema/temporal` (the
 * shared parser; lossless ms round-trip per migration 0006).
 *
 * Public consumers receive `BiTemporalRow<T>` rows where domain fields
 * sit alongside `valid_time` + `txn_time` parsed `TstzRange` shapes.
 * This file is the only place the deserialization happens — other
 * modules import via `mapRow`.
 */
import { parseTstzRange, type BiTemporalRow, type TstzRange } from '@cortex/canonical-schema';

/**
 * Map a raw pg row (where tstzrange columns are wire-format strings) to
 * a typed `BiTemporalRow<T>`. Domain columns pass through unchanged;
 * `valid_time` + `txn_time` parse via `parseTstzRange`.
 */
export function mapRow<T>(row: Record<string, unknown>): BiTemporalRow<T> {
  const validRaw = row.valid_time;
  const txnRaw = row.txn_time;
  if (typeof validRaw !== 'string') {
    throw new Error('temporal-query: expected valid_time wire string');
  }
  if (typeof txnRaw !== 'string') {
    throw new Error('temporal-query: expected txn_time wire string');
  }
  const valid_time: TstzRange = parseTstzRange(validRaw);
  const txn_time: TstzRange = parseTstzRange(txnRaw);
  return {
    ...(row as T),
    valid_time,
    txn_time,
  } as BiTemporalRow<T>;
}

/**
 * Map an array of raw rows. Convenience wrapper around `mapRow`.
 */
export function mapRows<T>(rows: unknown[]): BiTemporalRow<T>[] {
  return rows.map((r) => mapRow<T>(r as Record<string, unknown>));
}

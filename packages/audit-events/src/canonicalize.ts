/**
 * Canonicalization helpers for `@cortex/audit-events`.
 *
 * These implement the caller-side canonicalization contract from
 * ADR-DB-003 §3 (the SQL hash function on the server side cannot
 * enforce these without walking the payload — caller is responsible):
 *
 *   - Strings: Unicode NFC-normalized. Already enforced by `schemas.ts`
 *     at parse time; `canonicalizeJsonValue` re-applies defensively if
 *     callers reach the canonicalize helpers outside the schema path.
 *   - Numbers: integers preferred where precision matters. Floats are
 *     allowed but hash-sensitive to serialization (JS → JSON vs.
 *     Postgres `numeric` can differ in trailing zeros). The library
 *     does not coerce; convention doc (sub-phase 8) instructs callers.
 *   - Timestamps inside payload: ISO-8601 UTC microsecond strings.
 *     Caller responsibility — heuristic detection (regex on values)
 *     would false-positive on legitimate non-timestamp data (order
 *     IDs, internal sequences). `isoMicrosecondString` is the public
 *     check helper for callers' own validation.
 *   - JSON-safe values only: enforced at the type boundary
 *     (`JsonValue` union has no Date / BigInt / Symbol / undefined /
 *     Function variant).
 *
 * Idempotent: `canonicalizeJsonValue(canonicalizeJsonValue(x))` ≡
 * `canonicalizeJsonValue(x)` for any `x`.
 */

import { SOFT_PAYLOAD_LIMIT_BYTES, type JsonObject, type JsonValue } from './types.js';

/**
 * Walk a `JsonValue` recursively and return a deep-copied,
 * NFC-normalized version. Strings (top-level and nested in arrays /
 * objects, including object keys) are normalized. Numbers, booleans,
 * and null are returned unchanged. Input is never mutated.
 */
export function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const normalizedKey = key.normalize('NFC');
      out[normalizedKey] = canonicalizeJsonValue(value[key] as JsonValue);
    }
    return out;
  }
  // number, boolean, null — pass through.
  return value;
}

export interface PayloadSizeReport {
  sizeBytes: number;
  exceedsSoftLimit: boolean;
}

/**
 * Approximate size of a payload's JSON serialization. Returns the
 * length of `JSON.stringify(payload)` (UTF-16 code units).
 *
 * Note: actual transmission to Postgres `jsonb` is UTF-8, so the byte
 * count differs for non-ASCII content. The 64 KB threshold is a
 * heuristic for the soft WARN signal (per planning-doc Decision 2 and
 * roadmap §1.9), not a hard cap; UTF-16-code-units accuracy is
 * sufficient. Switch to `Buffer.byteLength(s, 'utf8')` if exact byte
 * size matters for the same threshold.
 */
export function checkPayloadSize(payload: JsonObject): PayloadSizeReport {
  const sizeBytes = JSON.stringify(payload).length;
  return {
    sizeBytes,
    exceedsSoftLimit: sizeBytes > SOFT_PAYLOAD_LIMIT_BYTES,
  };
}

const ISO_MICROSECOND_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?Z$/;

/**
 * Validate that `value` is an ISO-8601 UTC string with microsecond (or
 * second) precision and trailing `Z`. Returns the string if it matches,
 * `null` otherwise. Used by callers to validate their own
 * timestamp-in-payload conversions per ADR-DB-003 §3.
 *
 * The library does NOT auto-coerce JS `Date` objects to this format
 * — JS `Date` has millisecond precision, so a Date-derived ISO string
 * would only ever be `.SSSZ` (3 fractional digits), losing the µs
 * resolution the canonical hash function expects. Callers with
 * µs-precision sources (server-side timestamps, OTel spans,
 * application-clock sources) must format explicitly.
 */
export function isoMicrosecondString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return ISO_MICROSECOND_REGEX.test(value) ? value : null;
}

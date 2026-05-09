/**
 * Date → tstzrange wire-format string. Per D8 (string-wire pass-through):
 * caller supplies JS `Date` objects; this module serializes to Postgres's
 * tstzrange literal form for parameterized query injection.
 *
 * Conventions (matching ADR-DB-001 §1):
 *   - lower bound: always inclusive `[`
 *   - upper bound: always exclusive `)`
 *   - upper bound `null` → empty (open range)
 *
 * Wire format: `["2026-04-22T10:00:00.000Z","2026-04-23T10:00:00.000Z")`
 *              or `["2026-04-22T10:00:00.000Z",)` for open upper.
 */
export function serializeTstzRange(lower: Date, upper: Date | null): string {
  const lo = lower.toISOString();
  const hi = upper === null ? '' : upper.toISOString();
  return `["${lo}","${hi}")`;
}

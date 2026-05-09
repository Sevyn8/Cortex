/**
 * Validate a table-name OR column-name argument before SQL
 * interpolation. Identifiers cannot be parameterized in Postgres
 * prepared statements; we interpolate via string concatenation. The
 * validator restricts to snake_case identifiers
 * (`[a-z][a-z0-9_]{0,62}`) — tight enough that SQL injection is
 * structurally impossible.
 *
 * Renamed from `validate-table.ts` in F03 Slice B.5 when `keyColumn`
 * validation joined the picture. Generic shape covers both kinds.
 */
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function validateIdentifier(name: string, kind: 'table' | 'column'): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `temporal-query: invalid ${kind} name ${JSON.stringify(name)}; ` +
        'expected snake_case identifier (a-z, 0-9, _; ≤63 chars).',
    );
  }
}

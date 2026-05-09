/**
 * Validate a table-name argument before SQL interpolation. Table names
 * cannot be parameterized in Postgres prepared statements; we
 * interpolate via string concatenation. The validator restricts to
 * snake_case identifiers (`[a-z][a-z0-9_]{0,62}`) — tight enough that
 * SQL injection is structurally impossible.
 */
const TABLE_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function validateTableName(table: string): void {
  if (!TABLE_RE.test(table)) {
    throw new Error(
      `temporal-query: invalid table name ${JSON.stringify(table)}; ` +
        'expected snake_case identifier (a-z, 0-9, _; ≤63 chars).',
    );
  }
}

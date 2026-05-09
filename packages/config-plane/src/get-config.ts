import type { Queryable } from './queryable.js';
import { getNamespaceSchema } from './schema-registry.js';

/**
 * Slice A read API. Fetches the latest `tenant_config_version` row
 * matching `(tenant_id, namespace)` and validates against the
 * registered Zod schema for that namespace + the row's pinned
 * `schema_version`.
 *
 * **Slice A scope deliberately narrow** (per D8 read-only sub-lock):
 *   - No layered resolution. Caller supplies the exact namespace
 *     (e.g., `'tenant.theme'` not `'theme'`); workspace → tenant →
 *     platform fallback ships in Slice C.
 *   - No caching. Every call hits the DB. LRU + TTL ships in Slice C.
 *   - No write API. F02 keeps writing v=1 via Drizzle (Slice A
 *     reconciles the schema definition + writer to pass
 *     `namespace: 'tenant'`); user-driven writes go through the
 *     lifecycle in Slice B.
 *
 * Returns:
 *   - `null` if no row matches `(tenant_id, namespace)` — entity
 *     simply doesn't exist for this tenant in this namespace.
 *   - The validated parsed value if a row matches AND a schema is
 *     registered for `(namespace, schema_version)`.
 *
 * Throws:
 *   - `NamespaceSchemaNotRegisteredError` if a row exists but no
 *     schema is registered for the row's `(namespace, schema_version)`.
 *     Indicates a substrate-vs-app drift; caller should verify the
 *     consumer module's `registerNamespaceSchema` call ran.
 *   - Re-throws `ZodError` from the schema's `.parse()` if validation
 *     fails. Caller decides whether to surface or trap.
 *
 * Per D4: lazy + per-process LRU caching ships in Slice C; this
 * function is the read primitive that the cache wraps.
 *
 * Per Q-NEW-F04A-7: tenant context is passed via the `tenantId`
 * parameter (matches the `temporal-query` precedent — explicit, not
 * implicit via session GUC). RLS policy on `tenant_config_version`
 * remains as defense-in-depth.
 */
export class NamespaceSchemaNotRegisteredError extends Error {
  constructor(namespace: string, schemaVersion: number) {
    super(
      `config-plane: no schema registered for namespace ${JSON.stringify(namespace)} v=${schemaVersion}. ` +
        'Either the consumer module did not call registerNamespaceSchema for this version, or the row pins a stale version that no consumer ships anymore.',
    );
    this.name = 'NamespaceSchemaNotRegisteredError';
  }
}

interface ConfigVersionRow {
  config_json: unknown;
  schema_version: number;
}

export async function getConfig<T>(
  client: Queryable,
  tenantId: string,
  namespace: string,
): Promise<T | null> {
  const sql = `
    SELECT config_json, schema_version
    FROM tenant_config_version
    WHERE tenant_id = $1
      AND namespace = $2
    ORDER BY version_number DESC
    LIMIT 1
  `;
  const result = await client.query(sql, [tenantId, namespace]);
  if (result.rows.length === 0) return null;

  const row = result.rows[0] as ConfigVersionRow;
  const entry = getNamespaceSchema<T>(namespace, row.schema_version);
  if (entry === undefined) {
    throw new NamespaceSchemaNotRegisteredError(namespace, row.schema_version);
  }
  return entry.schema.parse(row.config_json);
}

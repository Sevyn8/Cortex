/**
 * Zod schema registry for F04 namespaces. Per D12: dynamic
 * registration with EXPLICIT schema_version on registration —
 * package-version-as-schema-version doesn't work (workspace packages
 * stay at 0.0.0). Drafts pin to the schema_version that existed at
 * draft-create time so subsequent schema bumps don't invalidate
 * in-flight drafts.
 *
 * Registry shape: keyed on `(namespace, version)` tuple. A namespace
 * MAY have multiple registered schema versions simultaneously
 * (drafts created against v=1 keep validating against v=1 even after
 * v=2 ships). At validate-time, F04 looks up the schema matching the
 * draft's pinned schema_version.
 *
 * In-memory, per-process. Phase 1 single-replica deploy is fine;
 * multi-replica distribution doesn't apply because each Cloud Run
 * replica registers schemas at startup from its own consumer
 * imports.
 *
 * Conflict policy: re-registering the SAME `(namespace, version)`
 * with a different schema throws — matches `registerAuditActions`
 * precedent. Re-registering with the IDENTICAL schema reference is
 * idempotent (handles duplicate side-effect-free imports).
 */

import type { ZodType } from 'zod';

export interface RegisteredSchemaEntry<T = unknown> {
  /** Dotted namespace path (e.g., `'platform.theme'`, `'tenant.i18n'`). */
  namespace: string;
  /** Explicit schema version — drafts pin to this number. */
  version: number;
  /** The Zod schema instance. */
  schema: ZodType<T>;
}

const registry = new Map<string, RegisteredSchemaEntry>();

function makeKey(namespace: string, version: number): string {
  return `${namespace}@${version}`;
}

export class NamespaceSchemaConflictError extends Error {
  constructor(namespace: string, version: number) {
    super(
      `config-plane: namespace ${JSON.stringify(namespace)} v=${version} already registered with a different schema. ` +
        'Each (namespace, version) pair maps to exactly one schema; bump version to ship a schema change.',
    );
    this.name = 'NamespaceSchemaConflictError';
  }
}

/**
 * Register a Zod schema for `(namespace, version)`. Idempotent if the
 * exact same schema reference is re-registered (e.g., consumer
 * module imported twice). Throws `NamespaceSchemaConflictError` if a
 * different schema is registered against an already-occupied key.
 */
export function registerNamespaceSchema<T>(
  namespace: string,
  schema: ZodType<T>,
  options: { version: number },
): RegisteredSchemaEntry<T> {
  const key = makeKey(namespace, options.version);
  const existing = registry.get(key);
  if (existing !== undefined) {
    if (existing.schema === (schema as ZodType<unknown>)) {
      // Same reference re-registered — idempotent.
      return existing as RegisteredSchemaEntry<T>;
    }
    throw new NamespaceSchemaConflictError(namespace, options.version);
  }
  const entry: RegisteredSchemaEntry<T> = {
    namespace,
    version: options.version,
    schema,
  };
  registry.set(key, entry as RegisteredSchemaEntry);
  return entry;
}

/**
 * Look up the registered schema for `(namespace, version)`. Returns
 * `undefined` if no schema is registered — F04 callers decide whether
 * absence is a hard error (validation paths) or a soft signal (read
 * paths returning unparsed JSON).
 */
export function getNamespaceSchema<T = unknown>(
  namespace: string,
  version: number,
): RegisteredSchemaEntry<T> | undefined {
  return registry.get(makeKey(namespace, version)) as RegisteredSchemaEntry<T> | undefined;
}

/**
 * Test-only helper. Clears the registry between test cases that
 * register competing schemas. Production code should never call
 * this; the registry is meant to be append-only at module init.
 */
export function resetSchemaRegistry(): void {
  registry.clear();
}

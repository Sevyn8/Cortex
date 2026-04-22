import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

/**
 * Create a Drizzle ORM client bound to a `pg` Pool.
 * Callers inject their per-service schema via the generic.
 */
export function createDrizzleClient<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(pool: Pool, schema?: TSchema): NodePgDatabase<TSchema> {
  return schema === undefined
    ? (drizzle(pool) as NodePgDatabase<TSchema>)
    : drizzle(pool, { schema });
}

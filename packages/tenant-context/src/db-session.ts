/**
 * Bridges the async-local tenant context to a Postgres session variable.
 *
 * After `bindTenantToDbSession` runs, RLS policies referencing
 * `cortex.current_tenant_id()` resolve to the bound tenant id for the
 * remainder of the current transaction. Without this binding, the
 * fail-closed reader (per ADR-DB-002 and migration 0003) raises
 * SQLSTATE 42501.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { getTenantOrThrow } from './context.js';
import { TenantValidationError } from './errors.js';

const tenantIdSchema = z.string().uuid();

/**
 * Bind a tenant id to the current Postgres session via `set_config(...,
 * true)`. The third argument `true` makes the binding transaction-scoped
 * (semantically equivalent to `SET LOCAL`), so the **caller MUST be inside
 * an open transaction**. RLS policies on tenant-scoped tables fire against
 * this binding.
 *
 * The tenant id is bound as a parameterized value via Drizzle's `sql`
 * tagged template — `${parsed.data}` is sent as a bind parameter, not
 * string-interpolated, so this is SQL-injection safe even if (somehow) an
 * attacker-influenced uuid string slipped past the validation step.
 *
 * @throws TenantValidationError if `tenantId` is not a valid UUID
 */
export async function bindTenantToDbSession(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<void> {
  const parsed = tenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new TenantValidationError(`Invalid tenant ID for DB binding: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  await db.execute(sql`SELECT set_config('app.tenant_id', ${parsed.data}, true)`);
}

/**
 * Convenience wrapper: read the tenant id from the async-local context
 * (via `getTenantOrThrow`) and bind it to the DB session. Use at the top
 * of every transaction that touches RLS-protected tables.
 *
 * As with `bindTenantToDbSession`, **caller MUST be inside an open
 * transaction**.
 *
 * @throws TenantContextMissingError if no async context is set
 * @throws TenantValidationError if the context-bound tenant id is invalid
 */
export async function ensureBoundToTenant(
  db: NodePgDatabase<Record<string, never>>,
): Promise<void> {
  const tenantId = getTenantOrThrow();
  await bindTenantToDbSession(db, tenantId);
}

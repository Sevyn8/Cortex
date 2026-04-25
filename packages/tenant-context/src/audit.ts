/**
 * Emits append-only audit events into `audit_event` (per migration 0004).
 *
 * Contract:
 * - Caller MUST have bound a tenant id to the DB session via
 *   `bindTenantToDbSession` / `ensureBoundToTenant` before calling.
 *   `audit_event` enforces RLS keyed on `cortex.current_tenant_id()` —
 *   without the binding the INSERT raises SQLSTATE 42501.
 * - Caller MUST be inside an open transaction. The session binding is
 *   transaction-scoped (`set_config(..., true)`), and the audit hash
 *   chain only stays consistent if the surrounding work and the audit
 *   row commit (or roll back) atomically.
 * - The `audit_chain_trigger` (BEFORE INSERT, see migration 0004)
 *   auto-fills `prev_hash` and `curr_hash` from the per-tenant chain.
 *   DO NOT supply these — the trigger ignores caller-provided values
 *   and recomputes them from the prior tenant row.
 * - `occurred_at` vs `inserted_at`: `occurred_at` is *when the event
 *   happened* (caller-controllable at the column level, defaults to
 *   `now()`); `inserted_at` is *when the row was written* (always
 *   `now()`, informational only). The audit hash chain hashes
 *   `occurred_at`. This API intentionally does NOT expose `occurred_at`
 *   as a parameter and lets the server default fire, because JS `Date`
 *   round-trips truncate µs precision and would diverge from the
 *   server-side hash input. Backfill / late-record paths that need to
 *   set `occurred_at` must do so via SQL with µs precision preserved
 *   (out of scope for Slice A).
 * - Append-only: UPDATE/DELETE on `audit_event` raise SQLSTATE 2F002
 *   from a row-level trigger. Audit events are immutable once emitted —
 *   callers cannot retro-edit them.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { TenantValidationError } from './errors.js';
import type { AuditAction } from './types.js';

const auditParamsSchema = z.object({
  tenantId: z.string().uuid(),
  actorType: z.enum(['service', 'user', 'system']),
  actorId: z.string().min(1).max(255),
  actorDescription: z.string().max(1024).optional(),
  action: z.enum([
    'TENANT_CREATED',
    'TENANT_UPDATED',
    'TENANT_STATUS_CHANGED',
    'TENANT_CONFIG_VERSION_CREATED',
  ] as const satisfies readonly AuditAction[]),
  resource: z.string().min(1).max(255),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type AuditParams = z.infer<typeof auditParamsSchema>;

/**
 * Insert one audit event row. Validates inputs with zod (throws
 * `TenantValidationError` with `cause` set to the ZodError on failure),
 * then sends a parameterized INSERT.
 *
 * @throws TenantValidationError if `params` fail schema validation
 */
export async function emitAuditEvent(
  db: NodePgDatabase<Record<string, never>>,
  params: AuditParams,
): Promise<void> {
  const parsed = auditParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new TenantValidationError(`Invalid audit event params: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  const p = parsed.data;
  const payloadJson = JSON.stringify(p.payload);
  await db.execute(sql`
    INSERT INTO audit_event (
      tenant_id,
      actor_type,
      actor_id,
      actor_description,
      action,
      resource,
      payload
    ) VALUES (
      ${p.tenantId},
      ${p.actorType},
      ${p.actorId},
      ${p.actorDescription ?? null},
      ${p.action},
      ${p.resource},
      ${payloadJson}::jsonb
    )
  `);
}

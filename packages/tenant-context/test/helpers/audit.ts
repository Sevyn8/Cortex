/**
 * Shared test helper for reading audit_event rows by tenant. Used by
 * `tenants.spec.ts`, `provision.spec.ts`, `provisioning-worker.spec.ts`,
 * and any future spec asserting on the audit chain.
 *
 * Wraps the read in a `db.transaction` with `bindTenantToDbSession` so
 * RLS on `audit_event` permits the SELECT. `actor_type` and `actor_id`
 * are surfaced as explicit fields for actor-attribution assertions.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bindTenantToDbSession } from '../../src/db-session.js';

export type AuditEventRow = {
  action: string;
  resource: string;
  actor_type: string;
  actor_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Returns audit_event rows for a tenant in canonical order. occurred_at
 * (clock_timestamp() per row from P0.10 Decision 11) is the primary
 * sort; ctid is the secondary tiebreaker for same-txn rows that
 * happen to share occurred_at (rare but defensive).
 */
export async function fetchAuditEvents(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<AuditEventRow[]> {
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    const result = await tx.execute<AuditEventRow>(
      sql`SELECT action, resource, actor_type, actor_id, occurred_at, payload
            FROM audit_event
            WHERE tenant_id = ${tenantId}
            ORDER BY occurred_at ASC, ctid ASC`,
    );
    return result.rows;
  });
}

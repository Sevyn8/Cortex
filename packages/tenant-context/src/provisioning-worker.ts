/**
 * F02 Slice A provisioning workflow worker.
 *
 * Invoked by Cloud Tasks dispatch from `tenants.provision`. Drives the
 * async state-machine transitions:
 *
 *   REQUESTED → (Enterprise: check `dedicated_db_approved`) → PROVISIONING
 *   PROVISIONING → READY  (after substrate verification per SA8 smoke test)
 *   READY → ACTIVE        (smoke-test success per SA5)
 *
 * Per planning-doc SA10: hard rollback on failure via
 * `cleanupFailedProvisioning` (lands sub-phase 4.5). No FAILED state.
 * Operator resubmits with same external_id after cleanup.
 *
 * Per planning-doc SA11: idempotency via Cloud Tasks `taskId` dedup +
 * worker pre-check (no-op when status is already at or past target).
 * Worker is safe to call multiple times for same tenant.
 *
 * Per planning-doc SA13 (locked 2026-04-27): Enterprise approval-flip
 * triggers re-enqueue at the approval HTTP endpoint (Slice D). The
 * worker itself just no-ops when `dedicated_db_approved=false`;
 * convention doc §4 captures the operator workflow.
 *
 * Audit emission shape:
 * - Each status transition emits `TENANT_STATUS_CHANGED` (via
 *   `tenants.setStatus`'s existing audit chain).
 * - Terminal-success emits `TENANT_PROVISIONED` (verb `CREATE` per
 *   planning-doc D6 hybrid catalog) AFTER the READY transition and
 *   BEFORE the READY → ACTIVE transition. Captures the post-
 *   provisioning state for compliance grep-ability.
 *
 * Each transition runs in its own DB transaction. There is no super-
 * transaction across the whole workflow — Cloud Tasks retry semantics
 * + the SA11 pre-check make per-step atomicity sufficient.
 */

import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenant, tenantKmsKey } from '@cortex/canonical-schema';
import { getActionByName } from '@cortex/audit-events';
import { TENANT_AUDIT_ACTIONS } from './audit-actions.js';
import { emitAuditEvent } from './audit.js';
import { bindTenantToDbSession } from './db-session.js';
import { tenants, type Actor } from './tenants.js';

/**
 * Service actor for all provisioning-worker emissions. Hardcoded per the
 * §4.14 pattern (AC01 swaps to a request-scoped resolver later). Caller-
 * supplied actor metadata from `tenants.provision` flows through the
 * Cloud Tasks payload and is preserved on `TENANT_PROVISIONED` for
 * forensic attribution; the worker-driven `TENANT_STATUS_CHANGED`
 * events use the service actor since they're system transitions.
 */
const PROVISIONING_ACTOR: Actor = {
  type: 'service',
  id: 'cortex-tenant-lifecycle',
};

export interface ProvisioningTaskPayload {
  /** UUID of the tenant being provisioned. */
  tenantId: string;
  /** Actor type from the `tenants.provision` caller (forensic attribution). */
  actorType: 'service' | 'user' | 'system';
  /** Actor id from the `tenants.provision` caller. */
  actorId: string;
  /** Optional actor description. */
  actorDescription?: string;
}

/**
 * Worker entry point. Called by Cloud Tasks HTTP dispatch.
 *
 * Returns void on success — Cloud Tasks treats 2xx as completed and the
 * task is ack'd from the queue. Throws on transient error — Cloud Tasks
 * retries per queue config (per planning-doc Q-OPEN-1: exp backoff,
 * max 5 attempts).
 *
 * Returns early (success) on:
 * - Tenant doesn't exist (post-cleanup or never-created — duplicate
 *   dispatch or operator deleted the row).
 * - Status is already past PROVISIONING (READY/ACTIVE/SUSPENDED/
 *   OFFBOARDING/TERMINATED — SA11 idempotency).
 * - Status is REQUESTED + tier=ENTERPRISE + `dedicated_db_approved=false`
 *   (SA13 — approval endpoint re-enqueues when flipped).
 *
 * @throws Error if smoke test fails (transient — Cloud Tasks retries).
 * @throws Error if `setStatus` rejects a transition (should not happen
 *   if state machine is consistent; surfaces as Cloud Tasks retry).
 */
export async function provisioningWorker(
  db: NodePgDatabase<Record<string, never>>,
  payload: ProvisioningTaskPayload,
): Promise<void> {
  const { tenantId } = payload;

  // 1. Pre-check (SA11 idempotency).
  const initial = await readTenantState(db, tenantId);
  if (initial === null) {
    // Tenant doesn't exist. Treat as success — no work, no retry.
    return;
  }

  // 2. Worker only advances from REQUESTED or PROVISIONING. All other
  //    states are terminal w.r.t. this worker (READY/ACTIVE = past;
  //    SUSPENDED/OFFBOARDING/TERMINATED = different lifecycle stage,
  //    not the worker's concern).
  if (initial.status !== 'REQUESTED' && initial.status !== 'PROVISIONING') {
    return;
  }

  // 3. REQUESTED → PROVISIONING (Enterprise gate per Q-OPEN-6).
  let currentStatus = initial.status;
  if (currentStatus === 'REQUESTED') {
    if (initial.tier === 'ENTERPRISE' && !initial.dedicated_db_approved) {
      // SA13: no-op; Slice D approval endpoint re-enqueues when flag flips.
      return;
    }
    await tenants.setStatus(db, tenantId, 'PROVISIONING', { actor: PROVISIONING_ACTOR });
    currentStatus = 'PROVISIONING';
  }

  // 4. PROVISIONING → READY (substrate smoke test per SA8).
  if (currentStatus === 'PROVISIONING') {
    const smokeOk = await runSmokeTest(db, tenantId);
    if (!smokeOk) {
      // Substrate verification failed. SA14 (locked 2026-04-27): smoke-test
      // failure is a known-unrecoverable case; trigger hard rollback per
      // SA10. Transient errors (DB timeout, KMS hiccup) skip cleanup and
      // re-throw plainly so Cloud Tasks retries. Only smoke-test failure —
      // a substrate inconsistency that retries can't fix — invokes cleanup.
      await cleanupFailedProvisioning(db, tenantId);
      throw new Error(
        `Provisioning smoke test failed for tenant ${tenantId}; substrate cleaned up. ` +
          `Resubmit via tenants.provision with the same external_id.`,
      );
    }
    await tenants.setStatus(db, tenantId, 'READY', { actor: PROVISIONING_ACTOR });

    // Emit TENANT_PROVISIONED — the terminal-success domain event per D6
    // hybrid catalog. Carries caller actor for forensic attribution
    // (the system transition is captured by TENANT_STATUS_CHANGED above).
    await emitProvisionedAudit(db, tenantId, payload);

    // 5. READY → ACTIVE (per SA5 — smoke test gates the flip; smoke test
    //    already ran above and passed, so advance directly).
    await tenants.setStatus(db, tenantId, 'ACTIVE', { actor: PROVISIONING_ACTOR });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Read the tenant fields the worker branches on. Returns null if the row
 * doesn't exist. `tenant` table has no RLS (control plane); plain SELECT
 * works without a session bind.
 */
async function readTenantState(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<{
  status: typeof tenant.status._.data;
  tier: typeof tenant.tier._.data;
  dedicated_db_approved: boolean;
} | null> {
  const rows = await db
    .select({
      status: tenant.status,
      tier: tenant.tier,
      dedicated_db_approved: tenant.dedicated_db_approved,
    })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * SA8 substrate verification smoke test. Phase 1 scope: confirm the
 * tenant row + `tenant_kms_key` row exist. `tenant_config_version` is
 * optional (only present if `initialConfig` was supplied to
 * `tenants.create`); IC01 (P5.2) will enforce v=1 once the vertical-
 * package seed lands per Q-OPEN-4.
 *
 * Forward-compat (Phase 2+): adds Cloud Run service reachability for
 * Enterprise tenants, KMS key API ping, GCS prefix HEAD per F02 spec
 * §1 acceptance criterion 3.
 *
 * `tenant_kms_key` is RLS-protected; worker binds `app.tenant_id` for
 * the read. The tenant row is non-RLS; plain SELECT.
 */
async function runSmokeTest(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<boolean> {
  // Tenant row exists.
  const tenantRows = await db
    .select({ id: tenant.id })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .limit(1);
  if (tenantRows.length === 0) {
    return false;
  }

  // tenant_kms_key row exists. RLS bind required for the read.
  return db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    const kmsRows = await tx
      .select({ id: tenantKmsKey.id })
      .from(tenantKmsKey)
      .where(eq(tenantKmsKey.tenant_id, tenantId))
      .limit(1);
    return kmsRows.length > 0;
  });
}

/**
 * Emit the terminal-success `TENANT_PROVISIONED` audit event. Captures
 * the post-provisioning state (status: READY) and preserves the
 * provisioning caller's actor identity for forensic attribution.
 */
async function emitProvisionedAudit(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  payload: ProvisioningTaskPayload,
): Promise<void> {
  await db.transaction(async (tx) => {
    await bindTenantToDbSession(tx, tenantId);
    await emitAuditEvent(tx, {
      tenantId,
      actorType: payload.actorType,
      actorId: payload.actorId,
      ...(payload.actorDescription !== undefined && {
        actorDescription: payload.actorDescription,
      }),
      action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_PROVISIONED'),
      verb: 'CREATE',
      resource: `tenant:${tenantId}`,
      after_state: {
        status: 'READY',
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Compensating cleanup for failed provisioning (SA10)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compensating cleanup for failed provisioning.
 *
 * Per planning-doc SA10 (locked 2026-04-27): hard rollback. When the
 * worker hits an unrecoverable failure (smoke-test failure under SA14),
 * this helper deletes the partial substrate atomically:
 *
 *   1. `tenant_config_version` rows (any version)
 *   2. `tenant_kms_key` row
 *   3. `tenant` row (last; FK ON DELETE RESTRICT blocks earlier deletion)
 *
 * Idempotent: re-calling on a fully-cleaned-up tenant is a no-op (DELETE
 * with no matching rows is harmless; the early-return on missing tenant
 * row makes the second call cheap).
 *
 * NOT a substitute for `tenants.terminate` (Slice C). This helper is for
 * tenants that NEVER reached READY — partial substrate, not fully
 * provisioned tenants undergoing termination. Distinctions:
 *
 *   - `cleanupFailedProvisioning`: no audit emission; tenant didn't
 *     exist publicly; operator resubmits with same `external_id`
 *     afterward.
 *   - `tenants.terminate` (Slice C): emits `TENANT_TERMINATED`; tenant
 *     was publicly active; row is soft-retained per spec §3 with
 *     `terminated_at` populated.
 *
 * Status guard: refuses to clean up tenants past PROVISIONING. If the
 * tenant has already advanced to READY/ACTIVE/etc., calling this helper
 * is a programming error — `tenants.terminate` is the correct path.
 *
 * RLS: `tenant_config_version` and `tenant_kms_key` both have FOR ALL
 * RLS policies (per migrations 0007 + 0009). DELETEs need session-bound
 * `app.tenant_id` via `bindTenantToDbSession`. The `tenant` table has
 * no RLS (control plane). Single transaction with binding handles all
 * three.
 *
 * @throws Error if tenant exists with status past PROVISIONING.
 */
export async function cleanupFailedProvisioning(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Read current status to guard against accidental cleanup of an
    //    advanced tenant. tenant table has no RLS — plain SELECT works.
    const result = await tx.execute<{ status: string }>(
      sql`SELECT status FROM tenant WHERE id = ${tenantId}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      // Already cleaned up; no-op (idempotency).
      return;
    }
    if (row.status !== 'REQUESTED' && row.status !== 'PROVISIONING') {
      throw new Error(
        `cleanupFailedProvisioning called on tenant ${tenantId} with status='${row.status}'; ` +
          `use tenants.terminate for tenants past PROVISIONING. This helper is only for ` +
          `partial substrate from failed provisioning workflows.`,
      );
    }

    // 2. Bind session for RLS-protected DELETEs.
    await bindTenantToDbSession(tx, tenantId);

    // 3. DELETE tenant_config_version (FK ON DELETE RESTRICT — must
    //    delete child rows before parent).
    await tx.execute(sql`DELETE FROM tenant_config_version WHERE tenant_id = ${tenantId}`);

    // 4. DELETE tenant_kms_key (FK ON DELETE RESTRICT).
    await tx.execute(sql`DELETE FROM tenant_kms_key WHERE tenant_id = ${tenantId}`);

    // 5. DELETE tenant row last; FK references now satisfied.
    await tx.execute(sql`DELETE FROM tenant WHERE id = ${tenantId}`);

    // 6. NO audit emission. Tenant never went public; cleaning up partial
    //    substrate is internal hygiene, not a compliance event. Convention
    //    doc §1 captures the operational rationale (SA10).
  });
}

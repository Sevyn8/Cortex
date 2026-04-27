/**
 * Shared types for @cortex/tenant-context.
 *
 * Tenant-row shapes are sourced from @cortex/canonical-schema (the Drizzle
 * schema) — this file derives narrower types via Pick where the public API
 * doesn't need every column.
 */

import type { Tenant } from '@cortex/canonical-schema';

/**
 * Tenant tier enum. Phase 1 only the STANDARD path is implemented;
 * ENTERPRISE is reserved for F02+ (dedicated Cloud SQL provisioning,
 * dedicated K8s/Cloud Run isolation) per F01 build prompt §2.
 */
export type TenantTier = 'STANDARD' | 'ENTERPRISE';

/**
 * Tenant lifecycle status. Full F02 lifecycle state machine per
 * ADR-LIFECYCLE-001:
 *
 *   REQUESTED → PROVISIONING → READY → ACTIVE
 *                                         ↓
 *                                    SUSPENDED ↔ ACTIVE
 *                                         ↓
 *                                    OFFBOARDING → TERMINATED
 *
 * State semantics:
 * - REQUESTED: provisioning kickoff awaited. Enterprise tenants also await
 *   `dedicated_db_approved=true` (per Q-OPEN-6).
 * - PROVISIONING: in-flight pipeline (KMS, GCS, control plane, etc.).
 * - READY: provisioning success; smoke test pending (per SA5).
 * - ACTIVE: tenant is live and serving traffic.
 * - SUSPENDED: write-blocked, reads allowed (data export still works).
 * - OFFBOARDING: export pending; grace-period clock running.
 * - TERMINATED: hard-deleted (post-termination queries return
 *   tenant-not-found via application-layer filtering).
 *
 * Allowed transitions are enforced in `tenants.ts`'s `ALLOWED_TRANSITIONS`
 * map. The DB CHECK constraint (`tenant_status_check` per migration 0010)
 * is the value-set guard; transition guards are in-code.
 */
export type TenantStatus =
  | 'REQUESTED'
  | 'PROVISIONING'
  | 'READY'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'OFFBOARDING'
  | 'TERMINATED';

/**
 * Public-shape tenant projection. Excludes timestamps which most callers
 * don't need; full row shape is available via the canonical-schema
 * `Tenant` type when timestamps are required.
 */
export type TenantSummary = Pick<Tenant, 'id' | 'external_id' | 'display_name' | 'tier' | 'status'>;

/**
 * Snapshot held by the AsyncLocalStorage context store. Single field
 * today; future fields will land as their consumers ship.
 *
 * TODO(AC01): add userId — set by AC01 auth middleware after JWT
 * validation, propagated through downstream calls.
 * TODO(P0.6 Phase 2): add correlationId — set by the observability
 * library's request middleware, used to thread a single request through
 * all log lines and metrics.
 */
export interface TenantContextSnapshot {
  tenantId: string;
}

// `AuditAction` literal-union retired in P0.10 sub-phase 7. The
// canonical tenant-lifecycle action set is now `TENANT_AUDIT_ACTIONS`
// in `./audit.js` (registered via `@cortex/audit-events`); the
// literal-union name type is `TenantAuditAction = (typeof
// TENANT_AUDIT_ACTIONS)[number]['name']`.

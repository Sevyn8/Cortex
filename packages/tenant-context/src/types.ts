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
 * Tenant lifecycle status. Transitions managed by F02 lifecycle state
 * machine: REQUESTED → PROVISIONING → ACTIVE → (SUSPENDED) → OFFBOARDING
 * → TERMINATED. Phase 1 (Slice A) sets PROVISIONING on create + supports
 * setStatus to ACTIVE; full state machine is F02 scope.
 */
export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';

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

/**
 * Lifecycle action names emitted as audit_event.action. Column-aligned with
 * migration 0004 schema.
 */
export type AuditAction =
  | 'TENANT_CREATED'
  | 'TENANT_UPDATED'
  | 'TENANT_STATUS_CHANGED'
  | 'TENANT_CONFIG_VERSION_CREATED';

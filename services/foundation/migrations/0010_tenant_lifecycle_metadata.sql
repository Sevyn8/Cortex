-- Migration 0010: F02 Slice A substrate — tenant lifecycle metadata
--
-- Extends `tenant.status` CHECK to support the F02 lifecycle state machine
-- (REQUESTED, READY, OFFBOARDING) per planning doc D7. Adds 5 lifecycle
-- metadata columns: `last_key_rotated_at`, `terminated_at`,
-- `offboarding_grace_until` (timestamps; populated by F02 lifecycle
-- workflows) and two operational flags: `legal_hold` (Q-OPEN-3; blocks
-- termination), `dedicated_db_approved` (Q-OPEN-6; gates Enterprise
-- Cloud SQL provisioning).
--
-- Migration is idempotent at the DDL layer: drops the existing inline-
-- named CHECK by its Postgres-auto-generated name (`tenant_status_check`)
-- and re-adds with the extended value set. Mirrors migration 0008's
-- pattern for the `audit_event_actor_type_check` extension. Existing
-- rows are vacuously valid — none can carry the new states, since the
-- prior CHECK rejected them.
--
-- The 5 new columns are added in a single ALTER TABLE statement (one
-- table-rewrite scan instead of five). All defaults are NULL or boolean
-- false; no backfill needed for existing tenants. The two boolean flags
-- carry NOT NULL DEFAULT false so existing rows materialize the
-- false-flag posture without an UPDATE pass.
--
-- Why both `tenant.legal_hold` (boolean) AND a future Slice C
-- `legal_hold` table? Phase 1 reality is one tenant; the boolean column
-- supports the per-tenant "block termination" semantic without forcing
-- a join. The Slice C `legal_hold` table (migration 0011) provides the
-- richer per-record / per-data-class shape when the first compliance
-- use case requires granular holds. Both will coexist initially; the
-- termination workflow checks both. See convention doc §6.
--
-- ALLOWED_TRANSITIONS in `@cortex/tenant-context`'s `tenants.ts` is
-- updated alongside this migration to keep DB and code state machines
-- in sync. The DB extends to allow the new states; the in-code
-- transition map adds the new edges.
--
-- References:
-- - docs/planning/f02-tenant-lifecycle-scope.md (D7 + Q-OPEN-3 + Q-OPEN-6)
-- - F02 build prompt §P1.2 (state machine REQUESTED → PROVISIONING → READY
--   → SUSPENDED / OFFBOARDING / TERMINATED)
-- - ADR-LIFECYCLE-001 (state machine + Cloud Tasks orchestration; Slice A)
-- - migration 0007 (predecessor; defined the original `tenant.status` CHECK)
-- - migration 0008 (precedent for inline-anonymous CHECK extension pattern)

-- 1. Extend tenant.status CHECK to add REQUESTED, READY, OFFBOARDING.
ALTER TABLE tenant
  DROP CONSTRAINT IF EXISTS tenant_status_check;

ALTER TABLE tenant
  ADD CONSTRAINT tenant_status_check
  CHECK (status IN (
    'REQUESTED',
    'PROVISIONING',
    'READY',
    'ACTIVE',
    'SUSPENDED',
    'OFFBOARDING',
    'TERMINATED'
  ));

COMMENT ON CONSTRAINT tenant_status_check ON tenant IS
  'F02 lifecycle state machine per ADR-LIFECYCLE-001: REQUESTED (awaits provisioning kickoff; Enterprise also awaits dedicated_db_approved), PROVISIONING (in-flight pipeline), READY (provisioning success; smoke test pending), ACTIVE (live, serving traffic), SUSPENDED (write-blocked, reads allowed), OFFBOARDING (export pending; grace period running), TERMINATED (hard-deleted).';

-- 2. Add 5 lifecycle metadata columns. Single ALTER TABLE = single
--    table-rewrite scan; new columns get the default value at scan time
--    (boolean flags) or remain NULL.
ALTER TABLE tenant
  ADD COLUMN last_key_rotated_at      timestamptz NULL,
  ADD COLUMN terminated_at            timestamptz NULL,
  ADD COLUMN offboarding_grace_until  timestamptz NULL,
  ADD COLUMN legal_hold               boolean     NOT NULL DEFAULT false,
  ADD COLUMN dedicated_db_approved    boolean     NOT NULL DEFAULT false;

-- 3. Comments documenting field semantics for future readers.
COMMENT ON COLUMN tenant.last_key_rotated_at IS
  'Timestamp of most recent KMS key rotation. NULL until first rotation. Set by F02 tenants.rotateKeys workflow (Slice D). Used to schedule the 90-day rotation cadence (per spec §5).';

COMMENT ON COLUMN tenant.terminated_at IS
  'Timestamp tenant moved to TERMINATED state. NULL until termination. Set by F02 tenants.terminate workflow (Slice C). Audit trail; tenant rows are soft-retained post-termination per spec §3 (post-termination queries return tenant-not-found via application-layer filtering).';

COMMENT ON COLUMN tenant.offboarding_grace_until IS
  'Deadline by which tenant must be terminated after offboarding starts. Set by F02 tenants.offboard (Slice C); default grace period is 30 days. NULL while tenant is in non-OFFBOARDING states.';

COMMENT ON COLUMN tenant.legal_hold IS
  'Per-tenant legal hold flag (Q-OPEN-3). When true, tenants.terminate refuses to proceed with hard delete. Phase 1 single-flag scope; per-record / per-data-class hold table (legal_hold) lands in Slice C migration 0011 for richer semantics. Both will be checked by the termination workflow.';

COMMENT ON COLUMN tenant.dedicated_db_approved IS
  'Manual approval gate for Enterprise dedicated Cloud SQL provisioning (Q-OPEN-6). When false, F02 provisioning workflow holds at REQUESTED for ENTERPRISE-tier tenants; an operator marks this true via the control plane to release. Standard tenants ignore this flag.';

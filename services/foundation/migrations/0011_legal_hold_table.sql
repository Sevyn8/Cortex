-- Migration 0011: legal_hold table — F02 Slice C (granular hold path)
--
-- Adds the granular per-record / per-data-class legal-hold path alongside the
-- per-tenant fast path established in migration 0010. The shape is locked by
-- planning-doc D7 + Q-OPEN-3 fold-in + convention §6.3 + audit sub-phase 7.1
-- (SC6 lock).
--
-- Two-tier model:
--   - Fast path (migration 0010): tenant.legal_hold boolean. Single flag per
--     tenant. Termination workflow short-circuits on this when true.
--   - Granular path (this migration): legal_hold table. Scope discriminator
--     supports tenant / record / data_class. Termination workflow checks
--     EXISTS(SELECT 1 FROM legal_hold WHERE tenant_id = $1 AND released_at IS NULL).
--
-- Both checked at every terminate call. The boolean is the cheap O(1) lookup;
-- the table covers richer compliance scenarios (per-record holds for litigation
-- discovery, per-data-class holds for retention regulations).
--
-- CHECK constraints enforce the scope-discriminator invariants:
--   - scope='record'      → record_id NOT NULL
--   - scope='data_class'  → data_class NOT NULL
--   - scope='tenant'      → both can be NULL (whole-tenant hold)
-- Plus a release-pair invariant: released_at and released_by_user_id must be
-- set together or NULL together.
--
-- set_by_user_id / released_by_user_id are TEXT (not UUID) per Q-NEW-C3 lock.
-- Pre-AC01 there is no users table to FK against; post-AC01 the user-id format
-- is whatever AC01 standardizes (WorkOS ID, internal UUID, etc.). TEXT survives
-- that swap without a column-type migration.
--
-- RLS posture: ENABLE ROW LEVEL SECURITY only — no FORCE — matching the
-- workspace convention (production runtime SAs are non-super and naturally
-- subject to RLS; tests opt-in to FORCE per CLAUDE.md "Testing RLS-protected
-- tables"). FOR ALL with USING + WITH CHECK matches tenant_config_version /
-- tenant_quota_usage / tenant_kms_key (post-0009).
--
-- Indexes: a partial index on (tenant_id, released_at) WHERE released_at IS
-- NULL services the canonical "active holds for this tenant" query the
-- termination workflow runs at every terminate call. A second partial index
-- on released_at WHERE released_at IS NOT NULL services future retention
-- sweeps over historically-released holds.
--
-- References:
--   - docs/planning/f02-tenant-lifecycle-scope.md (D7 + Q-OPEN-3)
--   - docs/architecture/tenant-lifecycle-convention.md §6.3
--   - audit sub-phase 7.1 SC6 + Q-NEW-C3 locks
--   - migration 0007 (tenant FK pattern, RLS pattern)
--   - migration 0010 (tenant.legal_hold boolean — the fast path)

CREATE TABLE legal_hold (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid         NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  scope                text         NOT NULL CHECK (scope IN ('tenant', 'record', 'data_class')),
  record_id            uuid,
  data_class           text,
  reason               text         NOT NULL,
  set_by_user_id       text         NOT NULL,
  set_at               timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now()),
  released_at          timestamptz,
  released_by_user_id  text,

  CONSTRAINT legal_hold_scope_record_check
    CHECK ((scope = 'record' AND record_id IS NOT NULL) OR (scope <> 'record')),
  CONSTRAINT legal_hold_scope_data_class_check
    CHECK ((scope = 'data_class' AND data_class IS NOT NULL) OR (scope <> 'data_class')),
  CONSTRAINT legal_hold_release_pair_check
    CHECK ((released_at IS NULL AND released_by_user_id IS NULL) OR
           (released_at IS NOT NULL AND released_by_user_id IS NOT NULL))
);

COMMENT ON TABLE legal_hold IS
  'Granular legal hold records per F02 Slice C. tenant.legal_hold (migration 0010) is the per-tenant fast path; this table is the granular per-record / per-data-class path. Termination workflow checks BOTH at terminate-time. Holds with released_at IS NULL are active; released holds remain in the table as historical record for compliance audits.';

COMMENT ON COLUMN legal_hold.scope IS
  'Discriminator: tenant | record | data_class. record_id is required when scope=record; data_class is required when scope=data_class. Both NULL for scope=tenant (whole-tenant hold via the granular path).';

COMMENT ON COLUMN legal_hold.set_by_user_id IS
  'TEXT not UUID per Q-NEW-C3 lock — pre-AC01 there is no users table to FK against, and post-AC01 the user-id format is whatever AC01 standardizes (WorkOS ID, internal UUID, etc.). TEXT survives that swap without a column-type migration.';

COMMENT ON COLUMN legal_hold.released_at IS
  'NULL while the hold is active. Set together with released_by_user_id when an authorized user releases. Released holds remain in the table for the compliance audit trail; the partial index legal_hold_tenant_active_idx skips them.';

ALTER TABLE legal_hold ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_hold_tenant_isolation ON legal_hold
  FOR ALL
  TO public
  USING (tenant_id = cortex.current_tenant_id())
  WITH CHECK (tenant_id = cortex.current_tenant_id());

COMMENT ON POLICY legal_hold_tenant_isolation ON legal_hold IS
  'Per-tenant isolation matching tenant_config_version / tenant_quota_usage / tenant_kms_key (post-0009). Caller binds app.tenant_id via bindTenantToDbSession before any read/write.';

-- Canonical "active holds for this tenant" query that termination workflow
-- runs at every terminate call. Partial index keeps the working set small as
-- released holds accumulate over time.
CREATE INDEX legal_hold_tenant_active_idx
  ON legal_hold (tenant_id, released_at)
  WHERE released_at IS NULL;

-- Future retention sweeps over released holds (e.g., "delete holds released
-- more than N years ago" once a retention policy lands). Partial keeps it
-- small while no policy exists.
CREATE INDEX legal_hold_released_at_idx
  ON legal_hold (released_at)
  WHERE released_at IS NOT NULL;

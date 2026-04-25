-- Migration 0007: Control plane tables (F01 Slice A)
--
-- Creates the four control-plane tables per build prompt §F01 §1.4:
--   1. tenant                 — primary tenant registry (NO RLS — control plane)
--   2. tenant_config_version  — versioned tenant config (RLS enabled; F04 consumer)
--   3. tenant_quota_usage     — quota counters per (tenant, resource_class) (RLS enabled; F01 Slice C consumer)
--   4. tenant_kms_key         — per-tenant CMEK binding (RLS enabled; F02 consumer in Phase 2+)
--
-- Single-DB design choice: control plane lives in the same `cortex` Postgres
-- database as tenant-scoped data. Decision recorded in docs/future-roadmap.md
-- §10.1 (Resolved by this migration). Rationale: Phase 1 has one tenant; the
-- separation overhead of a second DB outweighs the isolation benefit at this
-- scale. F02 may revisit at multi-tenant traffic.
--
-- RLS posture (per ADR-DB-002):
--   - tenant table: NO RLS. It IS the registry that maps `app.tenant_id` to
--     a tenant — bootstrapping it via RLS would be circular. Control-plane
--     reads happen via privileged service paths (F02 lifecycle) or via
--     deliberately-non-RLS operator queries.
--   - tenant_config_version, tenant_quota_usage, tenant_kms_key: RLS ENABLED
--     with policies referencing `cortex.current_tenant_id()` so tenant context
--     is required for access. F01 middleware sets `app.tenant_id` per-request.
--   - No `FORCE ROW LEVEL SECURITY` here. Production runtime SAs are non-super
--     and naturally subject to RLS. Tests opt-in to FORCE per CLAUDE.md
--     "Testing RLS-protected tables" — that lives in test fixtures, not
--     production migrations.
--
-- Foreign keys: ON DELETE RESTRICT on every tenant_id FK. Tenant deletion
-- flows through F02 lifecycle (provisioning state machine REQUESTED → ... →
-- TERMINATED), not via cascading SQL DELETE. RESTRICT is the safety net.
--
-- Timestamps: all defaults use `date_trunc('millisecond', now())` — matches
-- the temporal-quantum invariant established by migration 0006 (the SCD
-- trigger) and the application-layer ms-precision read path in
-- packages/canonical-schema/src/temporal.ts. JS-Date round-trip becomes
-- lossless by design.
--
-- Bi-temporal columns deliberately NOT applied to the tenant table itself.
-- The tenant registry is point-in-time (current state); historical lifecycle
-- transitions are captured in audit_event chain (ADR-DB-003). Other tenant-
-- scoped DOMAIN tables (D-series) WILL use biTemporalColumns; the control
-- plane is a different shape.
--
-- Per F01 build prompt P1.1 §1.4 Control Plane Tables.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. tenant — primary tenant registry (NO RLS)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE tenant (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text         NOT NULL UNIQUE,
  display_name  text         NOT NULL,
  tier          text         NOT NULL CHECK (tier IN ('STANDARD', 'ENTERPRISE')),
  status        text         NOT NULL DEFAULT 'PROVISIONING'
                              CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
  created_at    timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now()),
  updated_at    timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now())
);

COMMENT ON TABLE tenant IS
  'Primary tenant registry. Control plane — NOT RLS-protected. Phase 1 only Standard tier path implemented; ENTERPRISE enum reserved for F02+. Lifecycle transitions in audit_event chain (ADR-DB-003).';

COMMENT ON COLUMN tenant.external_id IS
  'Caller-facing tenant identifier (slug-like, e.g., display-data, body-shop-india). Stable across the tenant''s lifetime.';

COMMENT ON COLUMN tenant.tier IS
  'Phase 1: only STANDARD path implemented (shared Postgres + RLS). ENTERPRISE path (dedicated Cloud SQL per F01 §2) reserved for F02+.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. tenant_config_version — versioned tenant configuration (F04 consumer)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE tenant_config_version (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid         NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  version_number      integer      NOT NULL,
  config_json         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now()),
  created_by_user_id  uuid,
  UNIQUE (tenant_id, version_number)
);

COMMENT ON TABLE tenant_config_version IS
  'Per-tenant versioned config (F04 consumer). RLS enabled — reads/writes scoped by app.tenant_id. version_number is monotonic per tenant. created_by_user_id NULL pre-AC01.';

ALTER TABLE tenant_config_version ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_config_isolation ON tenant_config_version
  FOR ALL
  TO public
  USING (tenant_id = cortex.current_tenant_id())
  WITH CHECK (tenant_id = cortex.current_tenant_id());

-- ─────────────────────────────────────────────────────────────────────────
-- 3. tenant_quota_usage — current quota counters per (tenant, resource_class)
--    (F01 Slice C enforcement consumer)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE tenant_quota_usage (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid         NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  resource_class  text         NOT NULL,
  current_value   bigint       NOT NULL DEFAULT 0,
  quota_limit     bigint       NOT NULL,
  window_start    timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now()),
  updated_at      timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now()),
  UNIQUE (tenant_id, resource_class, window_start)
);

COMMENT ON TABLE tenant_quota_usage IS
  'Quota counters per (tenant, resource_class, window_start). RLS enabled. Slice A creates the substrate; enforcement (token bucket, 429-on-exceed) lands in F01 Slice C.';

COMMENT ON COLUMN tenant_quota_usage.resource_class IS
  'Free-form for now (e.g., api_requests, storage_bytes, compute_seconds). F01 Slice C may constrain via CHECK or enum.';

ALTER TABLE tenant_quota_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_quota_usage_isolation ON tenant_quota_usage
  FOR ALL
  TO public
  USING (tenant_id = cortex.current_tenant_id())
  WITH CHECK (tenant_id = cortex.current_tenant_id());

-- ─────────────────────────────────────────────────────────────────────────
-- 4. tenant_kms_key — per-tenant CMEK binding (F02 consumer, Phase 2+)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE tenant_kms_key (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid         NOT NULL UNIQUE REFERENCES tenant(id) ON DELETE RESTRICT,
  kms_key_resource_name   text         NOT NULL,
  created_at              timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now()),
  rotated_at              timestamptz
);

COMMENT ON TABLE tenant_kms_key IS
  'Per-tenant CMEK binding. Phase 1: empty — getKeyForTenant() in @cortex/secrets returns env-level cortex-general-key regardless of tenant (per ADR-INFRA-004 §Decision 5). F02 populates this table + swaps the resolver when per-tenant CMEK lands in Phase 2+. See future-roadmap.md §1.1, §7.1.';

ALTER TABLE tenant_kms_key ENABLE ROW LEVEL SECURITY;

-- USING-only policy (no WITH CHECK): writes happen via privileged F02
-- lifecycle paths that bypass this policy by virtue of the writer's role
-- (F02-runtime SA). Tenant-scoped reads via RLS-bound roles see only their
-- own row.
CREATE POLICY tenant_kms_key_isolation ON tenant_kms_key
  FOR SELECT
  TO public
  USING (tenant_id = cortex.current_tenant_id());

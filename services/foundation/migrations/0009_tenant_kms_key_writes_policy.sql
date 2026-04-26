-- 0009_tenant_kms_key_writes_policy.sql
--
-- Extend tenant_kms_key RLS policy from SELECT-only to FOR ALL with WITH CHECK.
--
-- Slice A (migration 0007) shipped a SELECT-only policy on tenant_kms_key
-- on the assumption that writes would flow through a privileged F02
-- lifecycle SA. Slice B (per ADR-INFRA-007 Decision 1) provisions the row
-- synchronously inside @cortex/tenant-context's tenants.create() — which
-- runs under the caller's normal RLS-bound role. Without an INSERT
-- policy, RLS default-denies the write (SQLSTATE 42501).
--
-- The shape mirrors tenant_config_version's FOR ALL policy from migration
-- 0007: USING (tenant_id = cortex.current_tenant_id()) for reads,
-- WITH CHECK (tenant_id = cortex.current_tenant_id()) for writes. Caller
-- binds app.tenant_id via bindTenantToDbSession(tx, newTenantId) before
-- INSERTing — same pattern as tenant_config_version.
--
-- F02 will write to tenant_kms_key when ROTATING per-tenant keys; the
-- FOR ALL policy covers that lifecycle without further widening.
--
-- Companion: ADR-INFRA-007 (per-tenant CMEK migration path).

DROP POLICY tenant_kms_key_isolation ON tenant_kms_key;

CREATE POLICY tenant_kms_key_isolation ON tenant_kms_key
  FOR ALL
  TO public
  USING (tenant_id = cortex.current_tenant_id())
  WITH CHECK (tenant_id = cortex.current_tenant_id());

COMMENT ON POLICY tenant_kms_key_isolation ON tenant_kms_key IS
  'Tenant-scoped read + write policy. Slice B (ADR-INFRA-007) requires INSERT under the caller''s tenant-bound role; F02 lifecycle will UPDATE the same row on rotation. Both checked against cortex.current_tenant_id().';

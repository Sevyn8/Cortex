-- Migration 0003: RLS baseline
--
-- Creates the cortex.current_tenant_id() reader function used by every
-- tenant-scoped table's row-level-security policies. Per ADR-DB-002 Decision 2.
--
-- This migration defines NO policies and enables RLS on NO tables. Tenant-scoped
-- tables (D01 and downstream) apply the recipe below at creation time.
--
-- -----------------------------------------------------------------------------
-- Session-variable contract (ADR-DB-002 §1)
-- -----------------------------------------------------------------------------
-- F01 middleware (P1.1 — not yet built) will, at the start of every request's
-- transaction, issue:
--     SET LOCAL app.tenant_id = '<uuid>';
--
-- Notes:
--   - Qualified name `app.tenant_id` (with dot) is required — unqualified names
--     are reserved for Postgres internals and raise on unconfigured servers.
--   - SET LOCAL (transaction-scoped), never SET SESSION — session-scoped vars
--     leak across pooled connections.
--   - Only `app.tenant_id` is defined in Phase B. No `app.actor_id` (audit's
--     concern, ADR-DB-003) or `app.role` (admin-bypass deferred, ADR-DB-002 §4).
--
-- -----------------------------------------------------------------------------
-- Per-table recipe (copy-paste when adding a tenant-scoped table)
-- -----------------------------------------------------------------------------
-- 1. Enable RLS:
--      ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--
-- 2. Read policy (SELECT only):
--      CREATE POLICY tenant_read_policy ON <t>
--        FOR SELECT TO public
--        USING (tenant_id = cortex.current_tenant_id());
--
-- 3. Write policy (all DML with USING + WITH CHECK):
--      CREATE POLICY tenant_write_policy ON <t>
--        FOR ALL TO public
--        USING (tenant_id = cortex.current_tenant_id())
--        WITH CHECK (tenant_id = cortex.current_tenant_id());
--
-- The two-policy split (vs a single FOR ALL policy) leaves a seam for future
-- admin-bypass to override read semantics without touching write. Zero runtime
-- cost — planner sees equivalent expressions either way. See ADR-DB-002 §3.
--
-- -----------------------------------------------------------------------------
-- Deferred (ADR-DB-002 §4; revisit when SCR-20 audit service lands)
-- -----------------------------------------------------------------------------
--   - cortex_admin Postgres role with BYPASSRLS
--   - admin_read_policy / admin-bypass template
--   - Any cross-tenant reader path

CREATE FUNCTION cortex.current_tenant_id() RETURNS uuid
  LANGUAGE plpgsql STABLE PARALLEL SAFE
  AS $$
DECLARE
  v_raw text;
BEGIN
  -- current_setting(..., true) is the missing_ok form — returns NULL if the
  -- GUC has never been set in this session/transaction. Per ADR-DB-002 §2,
  -- both NULL and empty string are fail-closed paths — treated as "tenant
  -- context not established" rather than silently returning zero rows.
  v_raw := current_setting('app.tenant_id', true);

  IF v_raw IS NULL THEN
    RAISE EXCEPTION 'cortex.current_tenant_id: app.tenant_id is not set; refusing to evaluate tenant-scoped policy'
      USING ERRCODE = '42501';
  ELSIF v_raw = '' THEN
    RAISE EXCEPTION 'cortex.current_tenant_id: app.tenant_id is not set; refusing to evaluate tenant-scoped policy'
      USING ERRCODE = '42501';
  END IF;

  -- Invalid uuid text surfaces Postgres's native 22P02 (invalid_text_representation).
  -- That is also fail-closed — query aborts instead of evaluating policy against
  -- garbage. No explicit cast guard needed.
  RETURN v_raw::uuid;
END;
$$;

COMMENT ON FUNCTION cortex.current_tenant_id() IS
  'Fail-closed reader for app.tenant_id session variable. Raises SQLSTATE 42501 on NULL/empty GUC, 22P02 on invalid uuid text. STABLE PARALLEL SAFE. See ADR-DB-002 §2.';

-- Verification (run manually in psql after apply):
--
--   BEGIN;
--   SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000001';
--   SELECT cortex.current_tenant_id();
--   -- Expected: 00000000-0000-0000-0000-000000000001
--   ROLLBACK;
--
--   -- Unset GUC (fail-closed):
--   SELECT cortex.current_tenant_id();
--   -- Expected: ERROR 42501 insufficient_privilege
--
--   -- Invalid uuid:
--   BEGIN;
--   SET LOCAL app.tenant_id = 'not-a-uuid';
--   SELECT cortex.current_tenant_id();
--   -- Expected: ERROR 22P02 invalid_text_representation
--   ROLLBACK;

-- Migration 0016: F03 Slice C — SCD-policy-aware trigger rewrite.
--
-- Extends `cortex.cortex_scd_trigger()` to read SCD policy from the
-- F04 namespace `tenant.scd` and dispatch by per-entity-type config.
-- Default-when-absent = SCD Type 2 (Q-NEW-F03C-4 mandatory backward
-- compat). Type 1 (overwrite) implemented; Types 3/4/6 stubbed
-- pending HOLD #2 schema-design lock per Q-NEW-F03C-7.
--
-- Per Q-NEW-F03C-2 lock: namespace = `tenant.scd` (per-tenant only;
-- no cross-tenant default substrate per F04 D14).
-- Per Q-NEW-F03C-3: inline policy read in trigger; no caching.
-- Per Q-NEW-F03C-4: default-when-absent = Type 2.
--
-- Tenant-context tolerance:
--   The policy lookup queries `tenant_config_version` which is
--   RLS-bound (FOR ALL tenant_id = current_tenant_id()). Callers
--   without app.tenant_id bound (e.g., direct test INSERTs against
--   non-RLS test fixtures like retail_product) would otherwise hit
--   SQLSTATE 42501 from `cortex.current_tenant_id()`. The trigger
--   wraps the policy lookup in a BEGIN/EXCEPTION block catching
--   `insufficient_privilege` (42501) → fallback to NULL policy →
--   fallback to Type 2 default. This preserves test-fixture
--   behavior (bi-temporal.spec, retail_product.sql) where INSERTs
--   and UPDATEs run without a bound tenant context.
--
--   Production callers ALREADY bind tenant context via
--   `bindTenantToDbSession()` before any UPDATE/DELETE on
--   bi-temporal tables (RLS would fail-closed otherwise). The
--   exception path is a test-fixture accommodation, not a
--   production code path.
--
-- Property preservation:
--   - INSERT branch: unchanged from migration 0006 (ms-truncation;
--     no policy lookup; type-agnostic).
--   - UPDATE/DELETE Type 2 path: behavior identical to 0006 (close
--     OLD via in-place txn_time update + INSERT new-version row
--     for UPDATE; close OLD only for DELETE).
--   - Type 1 path: UPDATE returns NEW (in-place update; no history
--     preserved). DELETE returns OLD (physical delete; no logical
--     close).
--   - Reentry guard (pg_trigger_depth > 1) unchanged.
--
-- Forward-compat note (Slice C exit criterion):
--   If future F04 substrate work adds NULL-tenant_id support OR a
--   separate `platform_config` table + RLS carve-out, the trigger's
--   hardcoded Type-2 fallback can be replaced with a DB-driven
--   default lookup. The default-path is isolated in a single
--   COALESCE; replace point is clear.

CREATE OR REPLACE FUNCTION cortex.cortex_scd_trigger() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  policy_json   jsonb;
  entity_policy jsonb;
  scd_type      int;
BEGIN
  -- Reentry guard. Our own nested UPDATE below (closing OLD) re-fires this
  -- trigger; when pg_trigger_depth() > 1, pass the mutation through unchanged
  -- so Postgres applies the txn_time closure in place.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- INSERT branch — unchanged from migration 0006. Type-agnostic
  -- (ms-truncation applies to all SCD types).
  IF TG_OP = 'INSERT' THEN
    NEW.txn_time := tstzrange(
      date_trunc('millisecond', lower(NEW.txn_time)),
      upper(NEW.txn_time)
    );
    IF NEW.valid_time IS NOT NULL THEN
      NEW.valid_time := tstzrange(
        date_trunc('millisecond', lower(NEW.valid_time)),
        CASE WHEN upper(NEW.valid_time) IS NULL
             THEN NULL
             ELSE date_trunc('millisecond', upper(NEW.valid_time))
        END
      );
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE / DELETE: read SCD policy. Tolerate missing tenant context
  -- via EXCEPTION block (see header note for rationale).
  BEGIN
    SELECT config_json
      INTO policy_json
      FROM tenant_config_version
      WHERE tenant_id = cortex.current_tenant_id()
        AND namespace = 'tenant.scd'
      ORDER BY version_number DESC
      LIMIT 1;
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- No tenant context bound (test-fixture path) — fall back to
      -- no-policy → Type 2 default.
      policy_json := NULL;
  END;

  -- Extract per-entity policy keyed on table name. NULL when no row
  -- exists OR the table isn't in the policy record.
  entity_policy := policy_json -> TG_TABLE_NAME;

  -- COALESCE to Type 2 when no entity policy registered.
  scd_type := COALESCE((entity_policy ->> 'type')::int, 2);

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Type 1 — overwrite (no history)
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type = 1 THEN
    IF TG_OP = 'UPDATE' THEN
      -- Apply UPDATE in place; no row rotation; no txn_time mutation.
      RETURN NEW;
    END IF;
    -- DELETE: physical delete; no logical close.
    RETURN OLD;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Type 2 — new row per change (current default; pre-Slice-C
  -- behavior preserved)
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type = 2 THEN
    IF TG_OP = 'UPDATE' THEN
      -- a. Close OLD via in-place txn_time update. Nested; guard
      --    bypasses SCD logic on the re-fire.
      EXECUTE format(
        'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), date_trunc(''millisecond'', now())) WHERE id = $1',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
      ) USING OLD.id;

      -- b. INSERT a new-version row with caller's NEW values, fresh
      --    PK, fresh open txn_time.
      NEW.id       := gen_random_uuid();
      NEW.txn_time := tstzrange(date_trunc('millisecond', now()), NULL);

      EXECUTE format(
        'INSERT INTO %I.%I SELECT ($1).*',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
      ) USING NEW;

      -- c. Cancel caller's physical UPDATE.
      RETURN NULL;
    END IF;
    -- DELETE: logical close (no physical delete).
    EXECUTE format(
      'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), date_trunc(''millisecond'', now())) WHERE id = $1',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING OLD.id;
    RETURN NULL;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Types 3 / 4 / 6 — STUBBED at C.2 per Q-NEW-F03C-7.
  -- Schema accepts the type literal at C.1; real dispatch lock comes
  -- at HOLD #2 (between C.2 trigger rewrite and C.3 per-type tests).
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type IN (3, 4, 6) THEN
    RAISE EXCEPTION
      'cortex.cortex_scd_trigger: SCD Type % not yet implemented for %.% (F03 Slice C HOLD #2 work; Q-NEW-F03C-7 schema-design pending)',
      scd_type, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  -- Defensive — should never reach (Zod-validated policy guarantees
  -- the type is one of {1, 2, 3, 4, 6}).
  RAISE EXCEPTION
    'cortex.cortex_scd_trigger: unsupported SCD type % for %.% (substrate violation; check tenant_config_version namespace=tenant.scd integrity)',
    scd_type, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

COMMENT ON FUNCTION cortex.cortex_scd_trigger() IS
  'SCD-policy-aware trigger function. Attach via BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW. Reads policy from tenant_config_version namespace=tenant.scd; defaults to Type 2 when no policy registered (Q-NEW-F03C-4). Type 1 implemented; Types 3/4/6 stubbed pending F03 Slice C HOLD #2 (Q-NEW-F03C-7). Tolerates missing tenant context via insufficient_privilege EXCEPTION catch → Type 2 fallback. See ADR-DB-001 §2 + docs/planning/p1.4-f03-slice-c-scope.md (Slice C C.5 docs).';

-- Migration 0013: cortex.backfill_bitemporal helper (F03 Slice A).
--
-- Adds a single PL/pgSQL function `cortex.backfill_bitemporal(p_schema text,
-- p_table text)` for converting a legacy non-bi-temporal table to the
-- ADR-DB-001 recipe in-place.
--
-- Currently zero legacy tables in the codebase need backfilling — every
-- shipped table either follows the recipe or is in the bookkeeping
-- allowlist (per the F03 Slice A lint rule). This helper future-proofs:
-- when a previously-bookkeeping table reclassifies as domain, OR when an
-- external migration imports a non-bi-temporal table, the function
-- converts it idempotently.
--
-- Idempotency: the function early-returns on tables that already have
-- both `valid_time` and `txn_time` columns. Re-running on a backfilled
-- table is a no-op.
--
-- Per ADR-DB-001 + scope-doc SD3: this lives in the cortex schema
-- alongside cortex_scd_trigger and at_time_t. Usable from psql,
-- migrations, drizzle-kit invocations alike. No TS-side dependency.
--
-- The helper assumes the target table:
--   - Already has `id uuid PRIMARY KEY` (matches the recipe's primary-
--     key convention; trigger requires it).
--   - Already has `tenant_id uuid NOT NULL` (recipe convention).
--   - Has a single business-key column the caller names (`p_business_key`).
--   - Has NO existing GENERATED columns (incompatible with the
--     cortex_scd_trigger UPDATE branch's `($1).*` row expansion).
-- Caller-side validation lives in the application layer or in
-- migration review; this function does not pre-check.

CREATE FUNCTION cortex.backfill_bitemporal(
  p_schema       text,
  p_table        text,
  p_business_key text
) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_qualified text := format('%I.%I', p_schema, p_table);
  v_has_valid boolean;
  v_has_txn   boolean;
BEGIN
  -- Idempotency guard: if both bi-temporal columns already exist,
  -- assume backfill ran previously + early-return.
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = p_schema AND c.relname = p_table
      AND a.attname = 'valid_time' AND NOT a.attisdropped
  ) INTO v_has_valid;
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = p_schema AND c.relname = p_table
      AND a.attname = 'txn_time' AND NOT a.attisdropped
  ) INTO v_has_txn;

  IF v_has_valid AND v_has_txn THEN
    RAISE NOTICE 'cortex.backfill_bitemporal: %.% already bi-temporal; no-op.',
      p_schema, p_table;
    RETURN;
  END IF;

  -- Step 1: add the columns. valid_time gets a sane default of
  -- [now(), NULL); existing rows get a "valid forever from now"
  -- semantics. Operators wanting different valid-time semantics for
  -- existing rows must run a follow-up UPDATE before relying on
  -- as-of-prior queries.
  EXECUTE format(
    'ALTER TABLE %s ADD COLUMN IF NOT EXISTS valid_time tstzrange NOT NULL DEFAULT tstzrange(now(), NULL)',
    v_qualified
  );
  EXECUTE format(
    'ALTER TABLE %s ADD COLUMN IF NOT EXISTS txn_time tstzrange NOT NULL DEFAULT tstzrange(now(), NULL)',
    v_qualified
  );

  -- Step 2: attach the SCD trigger (post-0006 binding).
  EXECUTE format(
    'CREATE TRIGGER %I_scd BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger()',
    p_table, v_qualified
  );

  -- Step 3: business-key exclusion constraint over current versions.
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I_business_key_no_overlap '
    'EXCLUDE USING gist (tenant_id WITH =, %I WITH =, valid_time WITH &&) '
    'WHERE (upper(txn_time) IS NULL)',
    v_qualified, p_table, p_business_key
  );

  -- Step 4: temporal GiST index.
  EXECUTE format(
    'CREATE INDEX %I_temporal_gist ON %s USING gist (tenant_id, valid_time, txn_time)',
    p_table, v_qualified
  );

  -- Step 5: current-version partial index.
  EXECUTE format(
    'CREATE INDEX %I_tenant_current ON %s (tenant_id) WHERE upper(txn_time) IS NULL',
    p_table, v_qualified
  );

  RAISE NOTICE 'cortex.backfill_bitemporal: %.% backfilled (columns + trigger + indexes + exclusion).',
    p_schema, p_table;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION cortex.backfill_bitemporal(text, text, text) IS
  'F03 Slice A — convert a legacy table to the ADR-DB-001 bi-temporal recipe in-place. Idempotent. Caller validates target table has id (uuid PK) + tenant_id + the named business-key column + no GENERATED columns. See docs/planning/f03-slice-A-scope.md SD3.';

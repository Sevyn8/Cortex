-- Migration 0002: Bi-temporal helpers
--
-- Creates two cross-cutting primitives in the cortex schema:
--   1. cortex.cortex_scd_trigger() — SCD Type 2 trigger function, attachable
--      to any bi-temporal table. BEFORE UPDATE / BEFORE DELETE semantics per
--      ADR-DB-001 Decision 2.
--   2. cortex.at_time_t(valid_time, txn_time, ts_valid, ts_txn) — composable
--      range predicate. IMMUTABLE PARALLEL SAFE SQL, inlines at plan time.
--      Per ADR-DB-001 Decision 3.
--
-- This migration defines NO tables. Bi-temporal tables (D01 and downstream)
-- apply the recipe below and attach the trigger themselves.
--
-- -----------------------------------------------------------------------------
-- Per-table recipe (copy-paste when adding a bi-temporal table)
-- -----------------------------------------------------------------------------
-- Required columns (trigger reads these by name):
--   id           uuid      PRIMARY KEY DEFAULT gen_random_uuid()
--   tenant_id    uuid      NOT NULL                         -- RLS (ADR-DB-002)
--   business_key <type>    NOT NULL                         -- entity identity across versions
--   valid_time   tstzrange NOT NULL                         -- ADR-DB-001 §1
--   txn_time     tstzrange NOT NULL DEFAULT tstzrange(now(), NULL)
--
-- CONSTRAINT: tables using cortex.cortex_scd_trigger() must NOT declare columns
-- with GENERATED ALWAYS AS ... STORED or GENERATED ALWAYS AS IDENTITY. The
-- trigger's dynamic INSERT uses ($1).* row expansion; generated columns reject
-- explicit values on INSERT. Use BEFORE INSERT triggers or application-layer
-- computation for derived fields instead.
--
-- 1. Attach SCD trigger:
--      CREATE TRIGGER <t>_scd
--        BEFORE UPDATE OR DELETE ON <t>
--        FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger();
--
-- 2. Business-key uniqueness over current versions (ADR-DB-001 §4):
--      ALTER TABLE <t> ADD CONSTRAINT <t>_business_key_no_overlap
--        EXCLUDE USING gist (
--          tenant_id    WITH =,
--          business_key WITH =,
--          valid_time   WITH &&
--        ) WHERE (upper(txn_time) IS NULL);
--
-- 3. Temporal GiST index:
--      CREATE INDEX <t>_temporal_gist ON <t>
--        USING gist (tenant_id, valid_time, txn_time);
--
-- 4. Current-version hot-path index:
--      CREATE INDEX <t>_tenant_current ON <t> (tenant_id)
--        WHERE upper(txn_time) IS NULL;
--
-- -----------------------------------------------------------------------------
-- Deferred helpers (added when first consumer needs them — see ADR-DB-001 Impl Notes)
-- -----------------------------------------------------------------------------
--   cortex.<t>_as_of_valid(entity uuid, ts timestamptz)  — one-line wrapper, per-table
--   cortex.<t>_as_of_latest(entity uuid)                 — current-version shortcut
--   cortex.<t>_history(entity uuid)                      — full timeline
--   cortex.as_of_known(...)                              — system-time-only view
--   cortex.point_in_time_join(...)                       — A01 Feature Store (P4.x)
--   cortex.temporal_union(a, b)                          — prefer native `+` until use case arrives
--   cortex.temporal_intersection(a, b)                   — prefer native `*` until use case arrives

CREATE FUNCTION cortex.cortex_scd_trigger() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- Reentry guard. Our own nested UPDATE below (closing OLD) re-fires this
  -- trigger; when pg_trigger_depth() > 1, pass the mutation through unchanged
  -- so Postgres applies the txn_time closure in place.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- SCD Type 2 on UPDATE:
    --   a. Close OLD via in-place txn_time update. Nested; guard bypasses SCD logic.
    --   b. INSERT a new-version row with caller's NEW values, fresh PK, fresh open txn_time.
    --   c. Return NULL to cancel the caller's physical UPDATE.
    --
    -- now() is deliberately used in both the close UPDATE below (sets
    -- OLD.txn_time upper) and in NEW.txn_time assignment. Postgres now()
    -- returns transaction-start time, identical for both references, which
    -- guarantees OLD closes at T and NEW opens at T with no gap. Using
    -- clock_timestamp() would create a microsecond gap during which as-of
    -- queries return zero rows.
    EXECUTE format(
      'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), now()) WHERE id = $1',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING OLD.id;

    NEW.id       := gen_random_uuid();
    NEW.txn_time := tstzrange(now(), NULL);

    EXECUTE format(
      'INSERT INTO %I.%I SELECT ($1).*',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING NEW;

    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- SCD Type 2 on DELETE:
    --   a. Close OLD row (logical delete, no physical delete).
    --   b. Return NULL to cancel the caller's physical DELETE.
    EXECUTE format(
      'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), now()) WHERE id = $1',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING OLD.id;

    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'cortex.cortex_scd_trigger: unsupported TG_OP %', TG_OP;
END;
$$;

COMMENT ON FUNCTION cortex.cortex_scd_trigger() IS
  'SCD Type 2 trigger. Attach via BEFORE UPDATE OR DELETE FOR EACH ROW. Table must have id (uuid PK), valid_time (tstzrange), txn_time (tstzrange) columns. No GENERATED columns. See ADR-DB-001 §2.';
--> statement-breakpoint

CREATE FUNCTION cortex.at_time_t(
  p_valid_time tstzrange,
  p_txn_time   tstzrange,
  p_ts_valid   timestamptz,
  p_ts_txn     timestamptz
) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT p_valid_time @> p_ts_valid AND p_txn_time @> p_ts_txn
$$;

COMMENT ON FUNCTION cortex.at_time_t(tstzrange, tstzrange, timestamptz, timestamptz) IS
  'Composable bi-temporal predicate. Usage: WHERE cortex.at_time_t(valid_time, txn_time, $asOfBusiness, $asOfSystem). IMMUTABLE PARALLEL SAFE — inlines at plan time. See ADR-DB-001 §3.';

-- Verification (run manually in psql after apply):
--
--   \df cortex.*
--   -- Expected rows: at_time_t, cortex_scd_trigger
--
--   SELECT cortex.at_time_t(
--     tstzrange('2026-01-01'::timestamptz, '2026-12-31'::timestamptz),
--     tstzrange(now(), NULL),
--     '2026-06-15'::timestamptz,
--     now()
--   );
--   -- Expected: t

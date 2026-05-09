-- Migration 0017: F03 Slice C — SCD Types 3, 4, 6 trigger implementations.
--
-- Replaces 0016's stub-RAISE paths for Types 3/4/6 with real
-- dispatch logic per HOLD #2 locks (Q-NEW-F03C-7a/b/c). 0016 stays
-- immutable (Q-NEW-F03C-7d path α — new migration redefining the
-- function via CREATE OR REPLACE; not edits-in-place).
--
-- Type 3 — previous value in column:
--   UPDATE: caller's UPDATE proceeds in-place. OLD's value of the
--     `previousValueColumn` is captured into sibling column
--     `<previousValueColumn>_previous` on the NEW row.
--     Sibling column existence is checked against information_schema;
--     missing sibling raises a clean error (caller's migration is
--     responsible for the sibling column).
--   DELETE: physical delete (Type 3 isn't history-preserving for
--     deletes per canonical SCD spec).
--
-- Type 4 — history table:
--   UPDATE: caller's UPDATE proceeds in-place. OLD row INSERTed
--     into history table (`<TG_TABLE_SCHEMA>.<historyTableName>` or
--     `<TG_TABLE_SCHEMA>.<TG_TABLE_NAME>_history` default).
--   DELETE: physical delete from main + INSERT OLD into history.
--   History table must exist with same columns; missing → clean
--     RAISE per caller's-migration-responsibility lock
--     (Q-NEW-F03C-7b path (a)).
--
-- Type 6 — hybrid (Type 2 row rotation + Type 3 per-column previous):
--   UPDATE: row rotation (Type 2 semantics — close OLD txn_time,
--     INSERT NEW with rotated id, cancel caller's UPDATE) PLUS
--     NEW captures `<col>_previous = OLD.<col>` for each col in
--     `previousValueColumns`. Sibling column check applies per col.
--   DELETE: Type 2 logical close (no per-column capture on delete).
--
-- The previous-column capture pattern uses jsonb manipulation:
-- `to_jsonb(NEW) || jsonb_build_object(...)` then cast back via
-- `jsonb_populate_record(NULL::schema.tablename, jsonb)`. This
-- handles dynamic column names safely (no SQL injection — the
-- Postgres jsonb operator handles untyped JSON keys; format(%I)
-- handles the typed schema/table identifiers).
--
-- See ADR-DB-001 §2 + docs/planning/p1.4-f04-configuration-plane-scope.md
-- §1 (D14 namespace deferral motivates Type 4's caller-creates path).
-- See docs/planning/f03-slice-C-scope.md (Slice C C.6 docs) for
-- HOLD #2 lock rationale.

CREATE OR REPLACE FUNCTION cortex.cortex_scd_trigger() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  policy_json   jsonb;
  entity_policy jsonb;
  scd_type      int;
  prev_col      text;
  history_name  text;
  prev_array    jsonb;
  new_jsonb     jsonb;
  sibling_col   text;
BEGIN
  -- Reentry guard. Our own nested UPDATE/INSERT below re-fires this
  -- trigger; pg_trigger_depth() > 1 short-circuits to avoid infinite
  -- recursion on the close-OLD/insert-NEW Type 2 + Type 6 paths.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- INSERT branch — unchanged from migration 0006/0016. Type-agnostic
  -- (ms-truncation applies regardless of SCD type).
  -- ─────────────────────────────────────────────────────────────────
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

  -- ─────────────────────────────────────────────────────────────────
  -- UPDATE / DELETE: read SCD policy with EXCEPTION fallback for
  -- callers without bound tenant context (test-fixture path).
  -- ─────────────────────────────────────────────────────────────────
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
      policy_json := NULL;
  END;

  entity_policy := policy_json -> TG_TABLE_NAME;
  scd_type := COALESCE((entity_policy ->> 'type')::int, 2);

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Type 1 — overwrite (no history)
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type = 1 THEN
    IF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
    RETURN OLD;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Type 2 — new row per change (current default)
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type = 2 THEN
    IF TG_OP = 'UPDATE' THEN
      EXECUTE format(
        'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), date_trunc(''millisecond'', now())) WHERE id = $1',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
      ) USING OLD.id;

      NEW.id       := gen_random_uuid();
      NEW.txn_time := tstzrange(date_trunc('millisecond', now()), NULL);

      EXECUTE format(
        'INSERT INTO %I.%I SELECT ($1).*',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
      ) USING NEW;

      RETURN NULL;
    END IF;
    -- DELETE: logical close
    EXECUTE format(
      'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), date_trunc(''millisecond'', now())) WHERE id = $1',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING OLD.id;
    RETURN NULL;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Type 3 — previous value in column
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type = 3 THEN
    prev_col := entity_policy ->> 'previousValueColumn';
    IF prev_col IS NULL THEN
      RAISE EXCEPTION
        'cortex.cortex_scd_trigger: Type 3 policy for %.% missing previousValueColumn (Zod-validated; substrate violation)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;

    IF TG_OP = 'UPDATE' THEN
      sibling_col := prev_col || '_previous';
      -- Verify sibling column exists; raise clean error if not.
      PERFORM 1
        FROM information_schema.columns
        WHERE table_schema = TG_TABLE_SCHEMA
          AND table_name   = TG_TABLE_NAME
          AND column_name  = sibling_col;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'cortex.cortex_scd_trigger: Type 3 sibling column %.%.% missing for previousValueColumn=% (caller migration responsibility per Q-NEW-F03C-7a)',
          TG_TABLE_SCHEMA, TG_TABLE_NAME, sibling_col, prev_col;
      END IF;

      -- Overlay <sibling_col> = OLD.<prev_col> onto NEW. Pass NEW
      -- itself as the template-record to jsonb_populate_record so
      -- the result preserves NEW's trigger-row type — assigning
      -- via dynamic `EXECUTE INTO NEW` loses the typed-row info
      -- and downstream `NEW.id := ...` access fails with
      -- "record NEW has no field id".
      NEW := jsonb_populate_record(
        NEW,
        jsonb_build_object(sibling_col, to_jsonb(OLD) -> prev_col)
      );

      RETURN NEW;
    END IF;
    -- DELETE: physical (Type 3 not history-preserving on delete)
    RETURN OLD;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Type 4 — history table
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type = 4 THEN
    history_name := COALESCE(
      entity_policy ->> 'historyTableName',
      TG_TABLE_NAME || '_history'
    );

    -- INSERT OLD into history. Caller's migration creates the table
    -- with same columns as source; missing → clean RAISE per
    -- Q-NEW-F03C-7b path (a) "caller's migration responsibility".
    BEGIN
      EXECUTE format(
        'INSERT INTO %I.%I SELECT ($1).*',
        TG_TABLE_SCHEMA, history_name
      ) USING OLD;
    EXCEPTION
      WHEN undefined_table THEN
        RAISE EXCEPTION
          'cortex.cortex_scd_trigger: Type 4 history table %.% missing for source %.% (caller migration responsibility per Q-NEW-F03C-7b)',
          TG_TABLE_SCHEMA, history_name, TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END;

    IF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
    -- DELETE: physical
    RETURN OLD;
  END IF;

  -- ─────────────────────────────────────────────────────────────────
  -- SCD Type 6 — hybrid (Type 2 row rotation + per-column previous)
  -- ─────────────────────────────────────────────────────────────────
  IF scd_type = 6 THEN
    IF TG_OP = 'UPDATE' THEN
      prev_array := entity_policy -> 'previousValueColumns';

      -- Capture previous values into sibling columns on NEW row
      -- BEFORE the row rotation INSERT. Build a single jsonb of all
      -- the <col>_previous overlays, then apply via
      -- jsonb_populate_record(NEW, ...) — passing NEW as the
      -- template preserves the trigger-row type so subsequent
      -- `NEW.id := ...` access works (assigning via dynamic
      -- `EXECUTE INTO NEW` loses the typed-row info).
      IF prev_array IS NOT NULL AND jsonb_array_length(prev_array) > 0 THEN
        new_jsonb := '{}'::jsonb;
        FOR prev_col IN
          SELECT jsonb_array_elements_text(prev_array)
        LOOP
          sibling_col := prev_col || '_previous';
          PERFORM 1
            FROM information_schema.columns
            WHERE table_schema = TG_TABLE_SCHEMA
              AND table_name   = TG_TABLE_NAME
              AND column_name  = sibling_col;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'cortex.cortex_scd_trigger: Type 6 sibling column %.%.% missing for previousValueColumns entry % (caller migration responsibility per Q-NEW-F03C-7c)',
              TG_TABLE_SCHEMA, TG_TABLE_NAME, sibling_col, prev_col;
          END IF;

          new_jsonb := new_jsonb || jsonb_build_object(
            sibling_col, to_jsonb(OLD) -> prev_col
          );
        END LOOP;

        NEW := jsonb_populate_record(NEW, new_jsonb);
      END IF;

      -- Now apply Type 2 row rotation with the captured-NEW row.
      EXECUTE format(
        'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), date_trunc(''millisecond'', now())) WHERE id = $1',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
      ) USING OLD.id;

      NEW.id       := gen_random_uuid();
      NEW.txn_time := tstzrange(date_trunc('millisecond', now()), NULL);

      EXECUTE format(
        'INSERT INTO %I.%I SELECT ($1).*',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
      ) USING NEW;

      RETURN NULL;
    END IF;
    -- DELETE: Type 2 logical close (no per-column capture on delete;
    -- canonical Type 6 doesn't track previous-on-delete).
    EXECUTE format(
      'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), date_trunc(''millisecond'', now())) WHERE id = $1',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING OLD.id;
    RETURN NULL;
  END IF;

  -- Defensive — should never reach (Zod-validated policy guarantees
  -- the type is one of {1, 2, 3, 4, 6}).
  RAISE EXCEPTION
    'cortex.cortex_scd_trigger: unsupported SCD type % for %.% (substrate violation; check tenant_config_version namespace=tenant.scd integrity)',
    scd_type, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$;

COMMENT ON FUNCTION cortex.cortex_scd_trigger() IS
  'SCD-policy-aware trigger function. All 5 SCD types implemented (1, 2, 3, 4, 6) per F03 Slice C HOLD #2 locks. Reads policy from tenant_config_version namespace=tenant.scd; defaults to Type 2 when no policy registered. Tolerates missing tenant context via insufficient_privilege EXCEPTION catch → Type 2 fallback. Type 3/6 require sibling <col>_previous columns on the table (caller migration responsibility). Type 4 requires the history table to exist (caller migration responsibility). See ADR-DB-001 §2, migration 0017 header, and docs/planning/f03-slice-C-scope.md.';

-- Migration 0006: Bi-temporal millisecond truncation
--
-- Resolves the cortex_scd_trigger flake captured in CI run 24893617678 on
-- 2026-04-24. Diagnostic data: see docs/deviations.md "bi-temporal test
-- flake" section.
--
-- Root cause: pg's default JS Date type parser truncates microseconds on
-- timestamptz round-trip. When INSERT and a subsequent SELECT now() collide
-- in the same millisecond AND the INSERT's microsecond > 0, a JS-Date-
-- truncated value passed back as $1::timestamptz lands BELOW the trigger's
-- recorded txn_time lower bound. Range-containment predicate `@>` evaluates
-- FALSE on the closed lower boundary; queries that should return the row
-- return zero rows.
--
-- Fix: extend cortex_scd_trigger to handle BEFORE INSERT in addition to
-- UPDATE and DELETE. The trigger becomes the single source of truth for
-- the temporal quantum; consumer tables can keep the vanilla DEFAULT
-- recipe (`tstzrange(now(), NULL)`), and the INSERT branch normalizes the
-- bounds to ms precision on write. The application-side read of these
-- columns already truncates to ms (packages/canonical-schema/src/temporal.ts
-- parses tstzrange endpoints into JS Date), so storing ms-precise values
-- matches what the application can observe. JS-Date round-trip becomes
-- lossless by design.
--
-- Trigger binding change: tables previously bound `BEFORE UPDATE OR DELETE`;
-- they must now bind `BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW` so the
-- INSERT branch fires. Existing consumer = test fixture only; updated in the
-- same commit. Future bi-temporal tables adopt the new binding from day one.
--
-- Property preservation:
--   - INSERT branch: rewrites NEW.txn_time and NEW.valid_time bounds to ms
--     precision. Returns NEW (proceed-with-mutation, not cancel).
--   - UPDATE branch: both old-row close + new-row open use the same
--     `date_trunc('millisecond', now())` expression. Postgres now() returns
--     transaction-start time (deterministic within a transaction), and
--     date_trunc is deterministic given its input — so both calls produce
--     the SAME value. The "no microsecond gap" invariant from migration
--     0002 is preserved.
--   - DELETE branch: same expression on the close-OLD UPDATE.
--   - Reentry guard (pg_trigger_depth > 1) is unchanged. Note: it still
--     RETURNs NEW, which on the nested-UPDATE path passes the row through;
--     the outer UPDATE branch already truncated NEW.txn_time before the
--     nested INSERT fires, so the inner re-firing is safe.
--
-- µs-precision audit (2026-04-25): no consumer of txn_time / valid_time
-- reads sub-millisecond precision. The audit chain's µs dependency lives
-- on audit_event.occurred_at — a separate column on a separate table; this
-- migration does not modify audit_event.

CREATE OR REPLACE FUNCTION cortex.cortex_scd_trigger() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- Reentry guard. Our own nested UPDATE below (closing OLD) re-fires this
  -- trigger; when pg_trigger_depth() > 1, pass the mutation through unchanged
  -- so Postgres applies the txn_time closure in place.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Normalize open-lower bounds on INSERT to ms precision so the column
    -- DEFAULT recipe (`tstzrange(now(), NULL)`) becomes JS-Date round-trip
    -- safe. The trigger is the single source of truth for the temporal
    -- quantum; consumer tables keep the vanilla DEFAULT and this branch
    -- normalizes on write.
    --
    -- Truncates valid_time bounds too (lower always; upper only if
    -- non-NULL) — consistent quantum across both bi-temporal columns,
    -- whether the caller backdated or used the default open range.
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

  IF TG_OP = 'UPDATE' THEN
    -- SCD Type 2 on UPDATE:
    --   a. Close OLD via in-place txn_time update. Nested; guard bypasses SCD logic.
    --   b. INSERT a new-version row with caller's NEW values, fresh PK, fresh open txn_time.
    --   c. Return NULL to cancel the caller's physical UPDATE.
    --
    -- date_trunc('millisecond', now()) — see migration header. now() returns
    -- transaction-start time so both call sites here produce the SAME value;
    -- truncation is deterministic given the input. OLD closes at T and NEW
    -- opens at T with no gap. JS-Date round-trip safe.
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

  IF TG_OP = 'DELETE' THEN
    -- SCD Type 2 on DELETE:
    --   a. Close OLD row (logical delete, no physical delete).
    --   b. Return NULL to cancel the caller's physical DELETE.
    EXECUTE format(
      'UPDATE %I.%I SET txn_time = tstzrange(lower(txn_time), date_trunc(''millisecond'', now())) WHERE id = $1',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING OLD.id;

    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'cortex.cortex_scd_trigger: unsupported TG_OP %', TG_OP;
END;
$$;

COMMENT ON FUNCTION cortex.cortex_scd_trigger() IS
  'SCD Type 2 trigger. Attach via BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW. Table must have id (uuid PK), valid_time (tstzrange), txn_time (tstzrange) columns. No GENERATED columns. Timestamps truncated to ms precision per migration 0006 — applies to INSERT (rewrite NEW), UPDATE (close OLD + open NEW), and DELETE (close OLD). See ADR-DB-001 §2.';

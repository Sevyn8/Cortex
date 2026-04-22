-- Migration 0004: Audit event chain
--
-- Lands the audit_event table with tamper-evident per-tenant SHA chain.
-- Per ADR-DB-003.
--
-- Components:
--   1. cortex.audit_canonical_hash() — IMMUTABLE SQL function, per-event hash
--      over all stable fields (Decision 3).
--   2. audit_event table (Decision 1) with structured actor triple (Decision 2).
--   3. cortex.audit_chain_trigger() — BEFORE INSERT stamps prev_hash + curr_hash;
--      BEFORE UPDATE/DELETE raise 2F002 for append-only enforcement (Decision 4).
--   4. Trigger attachment.
--   5. RLS policies per ADR-DB-002 templates (Decision 5).
--
-- Unlike 0002 and 0003 which only created cross-cutting helpers, this migration
-- lands a real tenant-scoped table AND applies the RLS pattern to it.
--
-- -----------------------------------------------------------------------------
-- Canonical hash contract (ADR-DB-003 Decision 3)
-- -----------------------------------------------------------------------------
-- The audit_canonical_hash function hashes nine fields:
--   event_id, tenant_id, actor_type, actor_id, actor_description, action,
--   resource, payload, occurred_at
-- via jsonb_build_object → ::text → sha256. occurred_at is normalized to
-- UTC ISO-8601 microseconds so client timezone does not leak into the hash.
--
-- NULL vs empty-string distinction: jsonb_build_object serializes
-- actor_description=NULL as {"actor_description": null} and actor_description=''
-- as {"actor_description": ""}. Different JSON → different hash. Intentional:
-- absent and empty-but-present are semantically different states.
--
-- Caller responsibilities (mirrored in CLAUDE.md "Audit events"):
--   - payload contains only JSON-safe values (string/number/bool/null/array/object)
--   - timestamps inside payload are ISO-8601 UTC microsecond strings
--   - string values in payload are Unicode NFC-normalized
--   - numbers prefer integers where precision matters
--
-- -----------------------------------------------------------------------------
-- Known limitations (Phase B deferrals; see ADR-DB-003 Impl Notes)
-- -----------------------------------------------------------------------------
--   - Concurrent-write race: two INSERTs for the same tenant can fork the chain.
--     No advisory lock, no partial unique index, no chain_tail table.
--     Revisit when any tenant exceeds ~10/sec sustained OR SCR-20 surfaces forks.
--   - No verify_chain function. Shape documented in ADR-DB-003 Impl Notes.
--   - No per-tenant sequence column. Ordering via (occurred_at DESC, event_id DESC).
--   - No named genesis row. NULL prev_hash is the convention.

CREATE FUNCTION cortex.audit_canonical_hash(
  p_event_id          uuid,
  p_tenant_id         uuid,
  p_actor_type        text,
  p_actor_id          text,
  p_actor_description text,
  p_action            text,
  p_resource          text,
  p_payload           jsonb,
  p_occurred_at       timestamptz
) RETURNS bytea
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT sha256(convert_to(jsonb_build_object(
      'event_id',          p_event_id::text,
      'tenant_id',         p_tenant_id::text,
      'actor_type',        p_actor_type,
      'actor_id',          p_actor_id,
      'actor_description', p_actor_description,
      'action',            p_action,
      'resource',          p_resource,
      'payload',           p_payload,
      'occurred_at',       to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )::text, 'UTF8'));
$$;

COMMENT ON FUNCTION cortex.audit_canonical_hash(uuid, uuid, text, text, text, text, text, jsonb, timestamptz) IS
  'Per-event SHA-256 over all stable audit fields. IMMUTABLE PARALLEL SAFE. occurred_at normalized to UTC ISO-8601 µs. See ADR-DB-003 §3.';
--> statement-breakpoint

CREATE TABLE audit_event (
  event_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  actor_type        text        NOT NULL CHECK (actor_type IN ('service', 'user', 'system')),
  actor_id          text        NOT NULL,
  actor_description text,
  action            text        NOT NULL,
  resource          text        NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  prev_hash         bytea,
  curr_hash         bytea       NOT NULL,
  inserted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_tenant_time ON audit_event (tenant_id, occurred_at DESC, event_id);

COMMENT ON TABLE audit_event IS
  'Tamper-evident audit log. Per-tenant SHA chain via BEFORE INSERT trigger. Append-only (UPDATE/DELETE raise 2F002). See ADR-DB-003.';
--> statement-breakpoint

CREATE FUNCTION cortex.audit_chain_trigger() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_prev bytea;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Per-tenant prev_hash lookup. Race condition: two concurrent INSERTs
    -- for the same tenant can see the same v_prev and fork the chain.
    -- Accepted in Phase B per ADR-DB-003 Impl Notes; revisit when write
    -- concurrency warrants advisory lock / chain-tail / partial unique index.
    SELECT curr_hash INTO v_prev
      FROM audit_event
      WHERE tenant_id = NEW.tenant_id
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT 1;

    NEW.prev_hash := v_prev;  -- NULL for genesis of this tenant's chain

    -- curr_hash = sha256(prev_hash || per_event_hash).
    -- COALESCE empty bytea keeps the hash input deterministic for genesis rows.
    NEW.curr_hash := sha256(
      COALESCE(NEW.prev_hash, '\x'::bytea) ||
      cortex.audit_canonical_hash(
        NEW.event_id, NEW.tenant_id, NEW.actor_type, NEW.actor_id, NEW.actor_description,
        NEW.action, NEW.resource, NEW.payload, NEW.occurred_at
      )
    );

    RETURN NEW;
  END IF;

  -- Append-only enforcement: UPDATE and DELETE are rejected regardless of role.
  RAISE EXCEPTION 'audit_event is append-only (attempted %)', TG_OP
    USING ERRCODE = '2F002';  -- modifying_sql_data_not_permitted
END;
$$;

COMMENT ON FUNCTION cortex.audit_chain_trigger() IS
  'Audit chain trigger. BEFORE INSERT stamps prev_hash + curr_hash; BEFORE UPDATE/DELETE raise 2F002. See ADR-DB-003 §4.';
--> statement-breakpoint

CREATE TRIGGER audit_chain
  BEFORE INSERT OR UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION cortex.audit_chain_trigger();
--> statement-breakpoint

-- RLS per ADR-DB-002 templates. Applied in-migration because audit_event is
-- a real tenant-scoped table, not a recipe reference.
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_read_policy ON audit_event
  FOR SELECT TO public
  USING (tenant_id = cortex.current_tenant_id());
--> statement-breakpoint

CREATE POLICY tenant_write_policy ON audit_event
  FOR ALL TO public
  USING (tenant_id = cortex.current_tenant_id())
  WITH CHECK (tenant_id = cortex.current_tenant_id());

-- Verification (run manually in psql after apply):
--
--   \d audit_event
--   -- Expected: 12 columns, PK event_id, index audit_event_tenant_time, trigger audit_chain.
--
--   \df cortex.audit_*
--   -- Expected: audit_canonical_hash, audit_chain_trigger.
--
--   BEGIN;
--   SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000001';
--   INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource)
--     VALUES ('00000000-0000-0000-0000-000000000001', 'system', 'probe', 'create', 'tenant');
--   SELECT event_id, prev_hash, encode(curr_hash, 'hex') FROM audit_event
--     WHERE tenant_id = '00000000-0000-0000-0000-000000000001';
--   -- Expected: 1 row, prev_hash NULL, curr_hash non-null 64-char hex.
--   ROLLBACK;

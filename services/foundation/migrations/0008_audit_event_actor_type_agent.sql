-- Migration 0008: extend audit_event.actor_type CHECK constraint to include 'agent'
--
-- Per Cortex v2.2 build prompt §P0.10 (USER/SYSTEM/AGENT taxonomy) and
-- ADR-AU-001 §Decision (companion to ADR-DB-003). Adds 'agent' as a fourth
-- valid value alongside the existing 'service' / 'user' / 'system' from
-- migration 0004. 'agent' lands for autonomous decision-making actors:
-- MCP servers (P0.8), pipeline orchestrators (A02+), model-decision
-- emitters (A03+).
--
-- Migration is idempotent at the DDL layer: drops the existing inline-named
-- CHECK by its Postgres-auto-generated name and re-adds with the extended
-- value set. Existing rows are vacuously valid — no row carries
-- actor_type='agent' today (Phase 1 has only 'service' and 'system'
-- emitters from F01 Slice A and the audit-spec test fixtures).
--
-- Chain integrity: the canonical hash function (cortex.audit_canonical_hash)
-- already hashes actor_type as a text field. Adding 'agent' as a valid value
-- does not alter the hashing of existing rows, since their actor_type values
-- are unchanged. New rows with actor_type='agent' will hash to a new value
-- because the input differs — that is the correct, expected behavior.
--
-- Single-purpose migration: NO indexes added here. Index strategy for
-- SCR-22 elevated-review queries (per spec SCR-20-FR-012) is deferred to
-- when actual query shape is known; see future-roadmap.md §4.11.
--
-- Companion: migration 0004 (audit_event substrate), ADR-DB-003 (chain
-- integrity), ADR-AU-001 (library shape).

ALTER TABLE audit_event
  DROP CONSTRAINT IF EXISTS audit_event_actor_type_check;

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_actor_type_check
  CHECK (actor_type IN ('service', 'user', 'system', 'agent'));

COMMENT ON CONSTRAINT audit_event_actor_type_check ON audit_event IS
  'Actor taxonomy per ADR-AU-001 §Decision 6: service (internal callers), user (human-attributable), system (process-attributable), agent (autonomous AI / MCP / model-decision).';

-- Verification (run manually in psql after apply):
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--     WHERE conrelid = 'audit_event'::regclass
--       AND conname = 'audit_event_actor_type_check';
--
--   -- Expected: CHECK ((actor_type = ANY (ARRAY['service'::text, 'user'::text, 'system'::text, 'agent'::text])))
--
--   -- Insert one row of each actor_type for the same tenant (chain check):
--   BEGIN;
--   SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-00000000abcd', true);
--   INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource)
--     VALUES ('00000000-0000-0000-0000-00000000abcd', 'service', 'svc-foundation', 'TEST_PROBE', 'tenant');
--   INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource)
--     VALUES ('00000000-0000-0000-0000-00000000abcd', 'user',    'usr-amit',       'TEST_PROBE', 'tenant');
--   INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource)
--     VALUES ('00000000-0000-0000-0000-00000000abcd', 'system',  'sys-cron',       'TEST_PROBE', 'tenant');
--   INSERT INTO audit_event (tenant_id, actor_type, actor_id, action, resource)
--     VALUES ('00000000-0000-0000-0000-00000000abcd', 'agent',   'agt-mcp-core',   'TEST_PROBE', 'tenant');
--   SELECT actor_type, encode(prev_hash, 'hex') AS prev, encode(curr_hash, 'hex') AS curr
--     FROM audit_event
--     WHERE tenant_id = '00000000-0000-0000-0000-00000000abcd'
--     ORDER BY occurred_at, event_id;
--   -- Expected: 4 rows; row 1 has prev=NULL, rows 2-4 have prev = previous row's curr.
--   ROLLBACK;

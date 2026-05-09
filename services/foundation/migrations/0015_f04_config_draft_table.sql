-- Migration 0015: F04 Slice B — config_draft table.
--
-- Tenant-scoped draft state for the F04 lifecycle. Drafts are mutable
-- (author iterates), discardable, and may carry validation errors;
-- versions in tenant_config_version are immutable (audit chain).
-- Separate tables keep the invariants clean per F04 D3.
--
-- Status lifecycle (Q-NEW-F04B-5 lock):
--   'active'    — author iterating. UNIQUE per (tenant, namespace,
--                 author) at a time per Q-NEW-F04B-1.
--   'promoted'  — successful promote landed; promoted_to_version_id
--                 points to the new tenant_config_version row.
--                 Audit-trail-preserving (Q-NEW-F04B-5 (b)).
--   'discarded' — author abandoned the draft.
--
-- Q-NEW-F04B-1 UNIQUE shape: partial UNIQUE INDEX
--   (tenant_id, namespace, created_by_user_id) WHERE status = 'active'.
-- Discarded/promoted drafts don't occupy the slot — author can create
-- a new draft after promote/discard without colliding with their
-- historical drafts.
--
-- Author-only visibility (D3 sub-lock):
--   Pre-AC01: F04 lifecycle helpers add explicit
--     `created_by_user_id = $author` filter in app code. RLS policy
--     here only enforces tenant isolation.
--   Post-AC01: policy upgrades via follow-up migration to also
--     filter `created_by_user_id = cortex.current_user_id()`.
--
-- FK ON DELETE behavior:
--   tenant_id → tenant: RESTRICT. F02 termination cascade explicitly
--     DELETEs config_draft rows before tenant (matches sibling
--     tables tenant_config_version / tenant_kms_key / legal_hold).
--   promoted_to_version_id → tenant_config_version: SET NULL.
--     Defense in depth for out-of-band deletion. In-application
--     code never deletes versions (append-only invariant per D2);
--     termination cascade deletes drafts before versions; SET NULL
--     never fires in practice but prevents a hard FK violation if
--     ordering ever inverts.
--
-- Bi-temporal opt-out: config_draft is bookkeeping (queue of mutable
-- drafts, not a domain entity with valid-time history). Opt-out per
-- CLAUDE.md ### Bi-temporal table convention.

-- @bi-temporal: skip
CREATE TABLE config_draft (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  namespace                text         NOT NULL,
  schema_version           integer      NOT NULL DEFAULT 1,
  draft_json               jsonb        NOT NULL,
  status                   text         NOT NULL DEFAULT 'active'
                                          CHECK (status IN ('active', 'promoted', 'discarded')),
  validation_state         text         NOT NULL DEFAULT 'unvalidated'
                                          CHECK (validation_state IN ('unvalidated', 'valid', 'invalid')),
  validation_errors        jsonb,
  promoted_to_version_id   uuid         REFERENCES tenant_config_version(id) ON DELETE SET NULL,
  created_by_user_id       uuid         NOT NULL,
  created_at               timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now()),
  updated_at               timestamptz  NOT NULL DEFAULT date_trunc('millisecond', now())
);

-- Q-NEW-F04B-1 active-only UNIQUE.
CREATE UNIQUE INDEX config_draft_one_active_per_author
  ON config_draft (tenant_id, namespace, created_by_user_id)
  WHERE status = 'active';

-- RLS: tenant isolation. FOR ALL because Slice B writes + reads.
-- WITH CHECK matches USING per the tenant_config_version precedent
-- (writes also scoped to current tenant).
ALTER TABLE config_draft ENABLE ROW LEVEL SECURITY;

CREATE POLICY config_draft_tenant_isolation ON config_draft
  FOR ALL
  TO public
  USING (tenant_id = cortex.current_tenant_id())
  WITH CHECK (tenant_id = cortex.current_tenant_id());

-- Column comments.
COMMENT ON TABLE config_draft IS
  'F04 Slice B draft state. Tenant-scoped via RLS; author-only via created_by_user_id filter pre-AC01; RLS upgrade post-AC01. UNIQUE active per (tenant, namespace, author) per Q-NEW-F04B-1.';

COMMENT ON COLUMN config_draft.status IS
  'active: author iterating. promoted: landed → promoted_to_version_id. discarded: abandoned. UNIQUE active per (tenant, namespace, author) per Q-NEW-F04B-1.';

COMMENT ON COLUMN config_draft.validation_state IS
  'Updated by validateDraft. unvalidated → valid|invalid. Re-set to unvalidated on updateDraft if draft_json changes (caller refreshes).';

COMMENT ON COLUMN config_draft.validation_errors IS
  'Set by validateDraft when validation_state=invalid. Zod-error tree as JSON. NULL when validation_state in (unvalidated, valid).';

COMMENT ON COLUMN config_draft.promoted_to_version_id IS
  'Set by promoteDraft. Audit trail of which draft became which version per Q-NEW-F04B-5. NULL until promote (status: active|discarded). FK ON DELETE SET NULL — defense in depth; in-app code never deletes versions.';

COMMENT ON COLUMN config_draft.schema_version IS
  'Pinned at draft creation per F04 D12. Drafts created against schema v=1 keep validating against v=1 even after v=2 ships.';

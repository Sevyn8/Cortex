-- Migration 0014: F04 Configuration Plane — tenant_config_version reshape.
--
-- Adds the per-namespace versioning shape required by F04 per
-- docs/planning/p1.4-f04-configuration-plane-scope.md D1 + D9 + D12.
-- Pre-F04, tenant_config_version was row-per-(tenant, version_number)
-- with the entire config tree as a single JSONB blob. F04 requires
-- per-namespace versioning so a theme change in `tenant.*` doesn't bump
-- the version of `platform.*`, and Zod validation can be scoped per-
-- namespace.
--
-- Single migration covers the full F04-prep reshape per Q-NEW-F04A-9
-- operator override: mixing UNRELATED changes is what "one migration
-- at a time" prohibits. D9 (namespace + parent_version_id) and D12
-- (schema_version) are both F04-prep — splitting would create a broken
-- intermediate state and make the migration log read as two incoherent
-- steps when it's really one F04-prep change.
--
-- Reshape operations (single transactional shape change):
--   1. ADD COLUMN namespace text                         — D1
--   2. ADD COLUMN parent_version_id uuid (self-FK)       — D2
--   3. ADD COLUMN schema_version integer                 — D12
--   4. UPDATE backfill: namespace='tenant', schema_version=1,
--      parent_version_id=NULL on existing rows           — D9
--   5. ALTER COLUMN namespace SET NOT NULL               — D1
--   6. ALTER COLUMN schema_version SET NOT NULL          — D12
--   7. DROP CONSTRAINT old UNIQUE (tenant_id, version_number)
--   8. ADD CONSTRAINT new UNIQUE (tenant_id, namespace, version_number)
--
-- Backfill semantics (D9): existing rows seeded by F02 provisioning
-- (`packages/tenant-context/src/tenants.ts:347` writer with
-- `version_number=1`, `config_json='{}'::jsonb`) adopt
-- `namespace='tenant'` (the default namespace for tenant-scoped config),
-- `schema_version=1` (the genesis schema version), and
-- `parent_version_id=NULL` (genesis row, no parent in the chain).
--
-- F02 reconciliation (Q-NEW-F04A-7): two files updated in the same
-- Slice A commit set as this migration:
--   - packages/canonical-schema/src/drizzle/schema.ts:137-155 —
--     tenantConfigVersion pgTable definition gains the three new
--     columns + reshape UNIQUE constraint. Self-FK on parent_version_id
--     uses Drizzle's self-reference idiom.
--   - packages/tenant-context/src/tenants.ts:347 — Drizzle insert
--     gains namespace: 'tenant' in the values object. (schema_version
--     defaults to 1 in the column definition; parent_version_id defaults
--     to NULL.)
-- No-change call sites (forward-compatible):
--   - packages/tenant-context/src/export-archive.ts:257 (SELECT *)
--   - packages/tenant-context/src/provisioning-worker.ts:316
--     (DELETE WHERE tenant_id; namespace not referenced)
--
-- Backfill verification: dedicated test at
-- packages/config-plane/test/migration-0014-backfill.spec.ts uses the
-- DROP COLUMN → INSERT old-shape → re-add column → UPDATE pattern per
-- Q-NEW-F04A-6 lock to verify the UPDATE statement covers the right
-- cases against pre-migration data.

ALTER TABLE tenant_config_version
  ADD COLUMN namespace text;

ALTER TABLE tenant_config_version
  ADD COLUMN parent_version_id uuid REFERENCES tenant_config_version(id);

-- DEFAULT 1 at the DB level so omit-the-column INSERT paths land on 1
-- without callers having to know about schema_version. F02's Drizzle
-- writer omits schema_version (relies on default); raw-SQL test
-- INSERTs that pre-date this migration also benefit.
ALTER TABLE tenant_config_version
  ADD COLUMN schema_version integer DEFAULT 1;

UPDATE tenant_config_version
  SET namespace = 'tenant'
  WHERE namespace IS NULL;

ALTER TABLE tenant_config_version
  ALTER COLUMN namespace SET NOT NULL;

ALTER TABLE tenant_config_version
  ALTER COLUMN schema_version SET NOT NULL;

ALTER TABLE tenant_config_version
  DROP CONSTRAINT tenant_config_version_tenant_id_version_number_key;

ALTER TABLE tenant_config_version
  ADD CONSTRAINT tenant_config_version_tenant_namespace_version_key
  UNIQUE (tenant_id, namespace, version_number);

COMMENT ON COLUMN tenant_config_version.namespace IS
  'F04 config namespace (e.g., ''tenant'', ''platform'', ''flags''). Reshape from full-tree-blob model in 0014. F02-seeded v=1 rows backfill to ''tenant''. See docs/planning/p1.4-f04-configuration-plane-scope.md §0 + D1.';

COMMENT ON COLUMN tenant_config_version.parent_version_id IS
  'Parent in the version chain for this (tenant, namespace). NULL for genesis (v=1) rows. Used by promote/rollback in F04 Slice B + the optimistic-concurrency check per D13.';

COMMENT ON COLUMN tenant_config_version.schema_version IS
  'Zod schema version this row validates against. Drafts pin to the schema_version at draft-create time so subsequent schema bumps don''t invalidate in-flight drafts. F04 D12 lock.';

COMMENT ON TABLE tenant_config_version IS
  'Per-tenant per-namespace versioned configuration (F04 substrate). RLS enabled — reads/writes scoped by app.tenant_id. UNIQUE (tenant_id, namespace, version_number) enforces monotonic version_number per (tenant, namespace). Reshape from full-tree-blob model landed in 0014 per F04 D1/D2/D12.';

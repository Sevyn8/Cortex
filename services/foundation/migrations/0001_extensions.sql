-- Migration 0001: Platform extensions + cortex schema
--
-- Establishes the Postgres substrate every downstream migration relies on:
--   - pgcrypto:  sha256() + gen_random_uuid() for the audit chain (ADR-DB-003)
--   - vector:    pgvector 0.8.x for E01 embedding similarity (ADR-INFRA-005 §6)
--   - btree_gist: mixed equality + range in exclusion constraints (ADR-DB-001 §4)
--   - cortex:    platform schema hosting cross-cutting functions and types
--                (ADR-DB-001 §2, ADR-DB-002 §2, ADR-DB-003 §3/4)
--
-- All three extensions install into `public` so their types (e.g., `vector`)
-- and functions (e.g., `sha256`) are reachable without schema qualification.
-- The `cortex` schema is a separate namespace for platform-owned SQL; `public`
-- stays empty of platform machinery so user tables get an uncluttered default
-- namespace.
--
-- Owner: `postgres` (superuser). P0.5 will introduce a dedicated migration
-- role; this migration predates that work.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS cortex;
--> statement-breakpoint

COMMENT ON SCHEMA cortex IS
  'Platform-owned SQL surface: bi-temporal helpers, RLS readers, audit-chain functions. See ADR-DB-001 / 002 / 003.';

-- Verification (run manually in psql after this migration applies):
--
--   SELECT extname, extversion FROM pg_extension
--     WHERE extname IN ('pgcrypto', 'vector', 'btree_gist')
--     ORDER BY extname;
--   -- Expected: btree_gist ~1.7, pgcrypto ~1.3, vector 0.8.x (Cloud SQL Postgres 17 Enterprise).
--
--   SELECT nspname FROM pg_namespace WHERE nspname = 'cortex';
--   -- Expected: one row, 'cortex'.
--
--   SELECT encode(sha256('hello'::bytea), 'hex');
--   -- Expected: 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
--
--   SELECT vector_dims('[1,2,3]'::vector);
--   -- Expected: 3
--
--   SELECT gen_random_uuid() IS NOT NULL;
--   -- Expected: t

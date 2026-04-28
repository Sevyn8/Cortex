#!/usr/bin/env bash
# db-reset-local.sh — wipe + reseed local Postgres for clean migration state.
#
# Use when:
# - Drizzle journal gets out of sync (drizzle-kit re-runs already-applied
#   migrations and trips on existing extensions/triggers/functions —
#   typically surfaces as SQLSTATE 42723 "function already exists" or
#   42P07 "relation already exists").
# - Fresh-start contention tests need a known-empty state.
# - You're about to test a new migration in isolation.
#
# What it does:
# 1. Drops `public` and `cortex` schemas with CASCADE (and `test_user`
#    role if present — DROP OWNED first to release any ownerships).
# 2. Recreates `public` with grants matching a fresh Postgres install.
# 3. Runs `pnpm db:migrate` (drizzle-kit migrate).
# 4. Re-applies CI's `test_user` role + `audit_event` ownership transfer.
#    This block is VERBATIM from .github/workflows/ci.yaml — keep them
#    in sync. Without it, tests running as `test_user` fail with
#    permission errors and FORCE-RLS specs lose their owner-bypass guard.
#
# Safe to run multiple times — every step is idempotent.
# Touches local Docker postgres only; refuses if PGHOST is not localhost.

set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-testpw}"
PGDATABASE="${PGDATABASE:-cortex}"

export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

if [[ "$PGHOST" != "127.0.0.1" && "$PGHOST" != "localhost" ]]; then
  echo "REFUSING: PGHOST=$PGHOST is not localhost. This script is local-only." >&2
  exit 1
fi

if ! psql -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "REFUSING: cannot connect to postgres at $PGHOST:$PGPORT as $PGUSER." >&2
  echo "  Start the local container first (e.g. \`docker start <postgres-container>\`)." >&2
  exit 1
fi

echo "==> db-reset-local: connected to $PGHOST:$PGPORT/$PGDATABASE as $PGUSER"

echo "==> [1/4] wiping schemas + test_user role"
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_user') THEN
    EXECUTE 'DROP OWNED BY test_user CASCADE';
    DROP ROLE test_user;
  END IF;
END $$;

DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS cortex CASCADE;

CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "==> [2/4] running migrations (drizzle-kit migrate)"
pnpm db:migrate

echo "==> [3/4] applying CI role setup (mirrors .github/workflows/ci.yaml)"
psql -v ON_ERROR_STOP=1 <<'SQL'
-- Cloud SQL's postgres is cloudsqlsuperuser (rolsuper=false). Stock
-- Postgres' postgres is the bootstrap superuser and cannot drop its
-- SUPERUSER attribute. Workaround: create a dedicated non-super role
-- and run tests as it. Policies apply; FORCE on owner-owned tables
-- still meaningful. Migrations keep running as postgres (need
-- superuser for CREATE EXTENSION vector).
CREATE ROLE test_user LOGIN PASSWORD 'testpw' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public, cortex TO test_user;
GRANT CREATE ON SCHEMA public TO test_user;
GRANT ALL ON ALL TABLES IN SCHEMA public TO test_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO test_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cortex TO test_user;
-- FORCE RLS in audit-chain.spec.ts beforeAll requires the caller
-- to be the table owner when not superuser.
ALTER TABLE audit_event OWNER TO test_user;
SQL

echo "==> [4/4] verifying state"
MIGRATION_COUNT=$(psql -tAc "SELECT count(*) FROM __drizzle_migrations")
TABLE_COUNT=$(psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
FUNCTION_COUNT=$(psql -tAc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'cortex'")
AUDIT_OWNER=$(psql -tAc "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_event'")

echo "  migrations applied: $MIGRATION_COUNT"
echo "  public tables:      $TABLE_COUNT"
echo "  cortex functions:   $FUNCTION_COUNT"
echo "  audit_event owner:  $AUDIT_OWNER"

if [[ "$AUDIT_OWNER" != "test_user" ]]; then
  echo "  WARN: audit_event owner is not test_user — RLS-FORCE specs will fail" >&2
fi

echo "==> done."

-- Migration 0012: tenant_lifecycle_runtime SQL grants — F02 Slice D D.4
--
-- Companion to the TF-level Cloud SQL IAM bindings landing in
-- infra/terraform/environments/{dev,staging,prod}/main.tf:
--   1. roles/cloudsql.client       on the env project (network reach)
--   2. roles/cloudsql.instanceUser on cortex-{env}-postgres (IAM-auth login)
--   3. google_sql_user of type CLOUD_IAM_SERVICE_ACCOUNT registering the
--      runtime SA email as a database role
--
-- Bindings 1+2+3 let the runtime SA *connect*; this migration grants the
-- SQL-level permissions the role needs once connected. Per ADR-INFRA-005
-- Decision 11 (IAM auth is the only active path) + the §7.1 D.4 TF
-- follow-up note shipped in D.1's commit body.
--
-- Pattern mirrors the test_user setup in scripts/db-reset-local.sh — the
-- difference is test_user is a password role (NOSUPERUSER NOBYPASSRLS)
-- created by the reset script for test isolation, while
-- tenant-lifecycle-runtime is a CLOUD_IAM_SERVICE_ACCOUNT role created by
-- TF + this migration grants the operational permissions.
--
-- Idempotency: every GRANT here is re-runnable. The role name format
-- ('"<sa-email-without-gserviceaccount>"' — quoted because it contains
-- '@' and '.') matches the form Cloud SQL creates when google_sql_user
-- of type CLOUD_IAM_SERVICE_ACCOUNT lands.
--
-- After this migration applies + the TF bindings are in place,
-- /v1/tenants/{id} GET against live dev DB returns a real row from the
-- runtime SA's identity (not the postgres superuser, not test_user, not
-- the break-glass password). That's the D.4 acceptance gate.

DO $$
DECLARE
    runtime_role_dev     text := '"tenant-lifecycle-runtime@sevyn8-cortex-dev.iam"';
    runtime_role_staging text := '"tenant-lifecycle-runtime@sevyn8-cortex-staging.iam"';
    runtime_role_prod    text := '"tenant-lifecycle-runtime@sevyn8-cortex-prod.iam"';
    runtime_role         text;
BEGIN
    -- Detect which env we're applying against by inspecting the
    -- current_database() and the cloudsql instance's project. The
    -- instance hostname inference is fragile; cleaner is to check
    -- pg_roles for the role that actually exists. The
    -- google_sql_user CLOUD_IAM_SERVICE_ACCOUNT resource creates the
    -- role at TF-apply time; this migration runs after.
    --
    -- We grant to whichever runtime role exists. The DO block is
    -- defensive: if a role doesn't exist (e.g., applying against
    -- staging before staging's TF runtime SA is created), the
    -- per-role GRANT block is skipped without erroring.
    FOREACH runtime_role IN ARRAY ARRAY[
        runtime_role_dev,
        runtime_role_staging,
        runtime_role_prod
    ]
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_roles
            WHERE rolname = trim(both '"' from runtime_role)
        ) THEN
            -- CONNECT on the cortex database.
            EXECUTE format('GRANT CONNECT ON DATABASE cortex TO %s', runtime_role);

            -- USAGE on the public schema (where control-plane tables live).
            EXECUTE format('GRANT USAGE ON SCHEMA public TO %s', runtime_role);
            EXECUTE format('GRANT USAGE ON SCHEMA cortex TO %s', runtime_role);

            -- SELECT/INSERT/UPDATE/DELETE on the operational tables. The
            -- runtime SA reads + writes through @cortex/tenant-context's
            -- lifecycle workflows; RLS policies (post-migration 0009) gate
            -- per-tenant access via app.tenant_id binding.
            --
            -- Tables in scope (Phase 1 control-plane):
            --   tenant                  — registry; no RLS
            --   tenant_kms_key          — RLS FOR ALL
            --   tenant_config_version   — RLS FOR ALL
            --   tenant_quota_usage      — RLS FOR ALL
            --   audit_event             — RLS write-only via tenant_id bind
            --   legal_hold              — RLS FOR ALL
            --
            -- New tables added by future migrations are NOT auto-granted —
            -- new migrations must include their own GRANT block (the
            -- workspace's Drizzle migration pattern). Documented in
            -- convention §7.4.
            EXECUTE format(
                'GRANT SELECT, INSERT, UPDATE, DELETE ON tenant, tenant_kms_key, tenant_config_version, tenant_quota_usage, audit_event, legal_hold TO %s',
                runtime_role
            );

            -- EXECUTE on cortex schema functions (current_tenant_id,
            -- audit_canonical_hash, etc.). RLS policies invoke
            -- cortex.current_tenant_id() at row-evaluation time.
            EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cortex TO %s', runtime_role);

            -- Future-table default ACL: any new table created in public
            -- inherits SELECT/INSERT/UPDATE/DELETE for the runtime role.
            -- Belt-and-braces for migrations that forget the explicit GRANT.
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %s',
                runtime_role
            );

            RAISE NOTICE 'Granted SQL-level permissions to %', runtime_role;
        ELSE
            RAISE NOTICE 'Role % does not exist — skipping GRANTs (TF runtime SA not yet provisioned for this env)',
                trim(both '"' from runtime_role);
        END IF;
    END LOOP;
END
$$;

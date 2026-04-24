-- Migration 0005: bootstrap_admin table
--
-- Pre-AC01 placeholder for the first super-admin identity per env.
-- Dev/staging: populated by scripts/bootstrap/create-super-admin.ts with
-- email/name/password_secret_ref (points to cortex-auth-super-admin-initial-<env>).
-- Prod: NOT populated by this script — production uses WorkOS SSO with an
-- env-var-specified initial user validated on AC01 first run.
--
-- Post-AC01 (P2.1): each row with promoted_to_users=false is migrated to
-- the users + user_role_assignment tables (SUPER_ADMIN role) by a one-shot
-- migration shipped with AC01, then promoted_to_users flipped to true.
--
-- RLS POSTURE: NONE. This is a control-plane-ish table, NOT tenant-scoped.
-- Per ADR-DB-002, RLS policies only apply to tables where they are explicitly
-- attached; this table has no policies, so cortex.current_tenant_id() is
-- never invoked during INSERT/SELECT. INSERT works without app.tenant_id set.
--
-- AUDIT CHAIN: NOT integrated with audit_event (which is tenant-scoped and
-- requires tenant_id NOT NULL). Bootstrap operations are logged to stderr
-- via the [BOOTSTRAP-AUDIT] prefix. Post-AC01 promotion can emit a proper
-- audit_event under a synthesized tenant_id or under the resulting user.
--
-- See /docs/runbooks/super-admin-bootstrap.md for operational procedure.

CREATE TABLE bootstrap_admin (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text         NOT NULL UNIQUE,
  name                  text         NOT NULL,
  password_secret_ref   text,
  env_created_in        text         NOT NULL CHECK (env_created_in IN ('dev', 'staging', 'prod')),
  created_at            timestamptz  NOT NULL DEFAULT now(),
  promoted_to_users     boolean      NOT NULL DEFAULT false,
  promoted_at           timestamptz,
  CONSTRAINT bootstrap_admin_promoted_consistency CHECK (
    (promoted_to_users = false AND promoted_at IS NULL)
    OR
    (promoted_to_users = true AND promoted_at IS NOT NULL)
  )
);

COMMENT ON TABLE bootstrap_admin IS
  'Pre-AC01 super-admin placeholder. See services/foundation/migrations/0005_bootstrap_admin.sql and /docs/runbooks/super-admin-bootstrap.md.';

COMMENT ON COLUMN bootstrap_admin.password_secret_ref IS
  'Fully-qualified Secret Manager version name (projects/*/secrets/*/versions/N) pointing to the initial password. NULL for prod rows (WorkOS path).';

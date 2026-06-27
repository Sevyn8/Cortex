# Super Admin bootstrap

Procedure for creating the first Super Admin identity per environment. Dev
and staging run a local CLI that writes a `bootstrap_admin` row and stores
the initial password in Secret Manager. Production uses Auth0 SSO — no
password, no CLI.

Authoritative: P0.9 build prompt (`docs/build-prompts/cortex_build_prompts_v3.md:851`)

- ADR-SEQ-001 amendment. AC01 (P2.1) consumes the `bootstrap_admin` row at
  promotion time.

## When to run

- **Dev / staging**: once per env, before first AC01 use. Re-runs with a
  row present are idempotent no-ops (see "Idempotency + what the script
  refuses" below).
- **Production**: never via this script. See
  [Production procedure](#production-procedure-auth0-sso).

## Prerequisites

- `gcloud auth application-default login` (once per session)
- `make db-proxy-<env>` running in another terminal (Cloud SQL Auth Proxy)
- `export GCP_PROJECT_ID=sevyn8-cortex-<env>`
- Terraform applied — the env's `cortex-auth-super-admin-initial-<env>`
  secret metadata must exist. (Created by `infra/terraform/environments/<env>/main.tf`
  `module "secret_super_admin_initial"`.)
- Your gcloud identity must have `roles/secretmanager.secretAccessor` on
  `cortex-db-postgres-break-glass-<env>` (usually covered by
  `cortex-admins` group membership).

## Dev / staging procedure

```
# In one terminal
make db-proxy-dev   # or db-proxy-staging

# In another terminal
export GCP_PROJECT_ID=sevyn8-cortex-dev
pnpm bootstrap:super-admin --env=dev
```

The script:

1. Validates preflight (TCP reachable on 127.0.0.1:5432, gcloud ADC valid,
   `GCP_PROJECT_ID` matches `--env`)
2. Prompts for email, name, password (twice to confirm; min 12 chars; 3
   confirmation retries allowed)
3. Writes the password to Secret Manager as a new version of
   `cortex-auth-super-admin-initial-<env>`
4. INSERTs a row into `bootstrap_admin` with the full version name in
   `password_secret_ref`
5. Emits a `[BOOTSTRAP-AUDIT]` line to stderr

Expected success output:

```
✓ Super admin bootstrap complete.
  Email:          <email>
  Secret version: projects/.../secrets/cortex-auth-super-admin-initial-<env>/versions/1

Next steps:
  - The bootstrap_admin row is staged for AC01 promotion.
  - Use this password to log in once AC01 (P2.1) ships.
  - See /docs/runbooks/super-admin-bootstrap.md#post-ac01-promotion.
```

## Production procedure (Auth0 SSO)

Production does **not** run this CLI. The bootstrap path:

1. Before first AC01 deploy, set an env var in the prod runtime config:
   ```
   CORTEX_SUPER_ADMIN_EMAIL=<initial-admin@sevyn8.com>
   ```
2. On AC01 first-run (P2.1 onward), AC01:
   - Looks up the Auth0 user matching that email (creating it via the
     Auth0 Management API if it doesn't exist yet)
   - Assigns the `SUPER_ADMIN` platform role
   - Emits an audit event under the synthesized bootstrap tenant
3. No initial password ever lives in prod Secret Manager. Authentication is
   Auth0 SSO (SAML or OIDC, tenant-configured).

The `cortex-auth-super-admin-initial-prod` secret is intentionally **not**
provisioned in Terraform. If you need to override this (e.g., for a
regulatory audit that demands a paper-trail password flow), write an ADR
first and adjust `infra/terraform/environments/prod/main.tf`.

## Emergency break-glass

Scenarios: Auth0 is compromised, AC01 has a bug that locks out every
admin, or a prod deploy of AC01 never set `CORTEX_SUPER_ADMIN_EMAIL`.

**This is a deliberate, audited procedure — not a casual flow.**

1. Establish incident context: page the on-call, open an incident ticket,
   capture the reason for break-glass in that ticket.
2. Use a dev or staging `bootstrap_admin` row to prove operator identity
   (document which row, in which env, to the incident ticket).
3. Grant temporary DB access to a trusted operator — typically via
   `cortex-db-postgres-break-glass-prod` + `make db-proxy-prod`.
4. Apply a one-shot SQL migration (authored for the incident, not checked
   into the regular migration chain) that either:
   - Inserts a bootstrap-shaped row and relies on AC01's promotion flow, OR
   - Directly creates the `users` + `user_role_assignment(SUPER_ADMIN)`
     rows per AC01 schema.
5. Post-incident: rotate Auth0 API credentials, rotate the bootstrap
   secret versions, reset AC01 role assignments as needed, file a
   post-mortem ADR.

If no super-admin identity has ever existed in prod (cold bootstrap
failure), the same procedure applies with slightly different SQL.

## Idempotency + what the script refuses

**Refuses production:** `--env=prod` exits with a pointer to this runbook's
Production procedure section. No exceptions.

**Refuses if `bootstrap_admin` has any row:** prints:

```
A super admin already exists in <env>:
   - email: <existing.email>
   - created_at: <ISO timestamp>
   - promoted_to_users: <bool>

If AC01 has shipped, use its promotion flow, not this script.
If you need to reset bootstrap_admin (dev only), see
/docs/runbooks/super-admin-bootstrap.md#reset-procedure.
```

Exit code 0 (idempotent — same end state as a successful first run, no
side effects).

**Refuses if preflight fails:** missing `GCP_PROJECT_ID`, mismatched env,
proxy not reachable, ADC expired — each exits with a specific guidance
message and exit code 1.

## Reset procedure

Dev-only. Removes the current bootstrap row so a subsequent run can create
a different one. Typical use: a typo in the email or name during initial
run, before AC01 has promoted the row.

**This deletes the row. If `promoted_to_users = true` (AC01 has
promoted), DO NOT DELETE via this procedure — use AC01's admin flows
instead, which preserve audit lineage.**

```
make db-proxy-dev
# In another terminal
psql "host=127.0.0.1 port=5432 user=postgres dbname=cortex" \
  -c "SELECT id, email, promoted_to_users FROM bootstrap_admin;"
# Verify promoted_to_users = false before deleting
psql "host=127.0.0.1 port=5432 user=postgres dbname=cortex" \
  -c "DELETE FROM bootstrap_admin WHERE email = '<email-to-remove>';"
```

The Secret Manager version in `cortex-auth-super-admin-initial-dev` is NOT
deleted by the DELETE — it stays around. Optional cleanup:
`gcloud secrets versions destroy <N> --secret=cortex-auth-super-admin-initial-dev --project=sevyn8-cortex-dev`.

Re-run `pnpm bootstrap:super-admin --env=dev` after cleanup.

## Post-AC01 promotion

When P2.1 AC01 ships, it includes a one-shot migration that:

1. Reads `bootstrap_admin` rows WHERE `promoted_to_users = false`
2. For each row:
   - Fetches the password via `@cortex/secrets.secrets.get`, using the
     stored `password_secret_ref`
   - Creates a `users` row with argon2id-hashed password
   - Creates a `user_role_assignment(SUPER_ADMIN)` row for that user
   - UPDATEs `bootstrap_admin` SET `promoted_to_users = true`,
     `promoted_at = now()` (the CHECK constraint enforces the transition)
3. (Optional) Destroys the Secret Manager version referenced by
   `password_secret_ref` — the secret itself is retained for audit.

After promotion, the `bootstrap_admin` row remains in the DB as a
historical record. No further writes or reads hit it — AC01 is the active
identity layer.

## References

- P0.9 build prompt — `docs/build-prompts/cortex_build_prompts_v3.md:851`
- ADR-SEQ-001 amendment — Phase 0 tail sequencing
- ADR-INFRA-004 — CMEK key hierarchy (why `cortex-secrets-key` encrypts
  the initial-password secret)
- CLAUDE.md §Secret Manager naming — `cortex-<category>-<name>` regex
- AC01 build prompt (P2.1) — promotion consumer
- `infra/terraform/environments/dev/main.tf` + `staging/main.tf` — secret
  metadata provisioning
- `services/foundation/migrations/0005_bootstrap_admin.sql` — DDL
- `scripts/bootstrap/` — CLI + business-logic package

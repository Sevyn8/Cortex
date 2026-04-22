# @cortex/foundation

Cross-cutting database primitives: migrations for bi-temporal helpers,
RLS baseline, and the audit chain (per ADR-DB-001 / 002 / 003).

## Contents

- `migrations/` — raw SQL migrations run by drizzle-kit
- `test/` — acceptance tests for each migration (bi-temporal, RLS, audit chain)
- `src/schema/` — reserved for future foundation-owned Drizzle schemas

## Running tests

1. Terminal 1: `make db-proxy-dev` (keeps cloud-sql-proxy foreground)
2. Terminal 2: `pnpm --filter @cortex/foundation test`

Tests resolve the dev break-glass password via gcloud; see
`test/helpers/db.ts`.

## Applying migrations

Use the Makefile targets from the repo root:

- `make db-migrate-dev`
- `make db-migrate-staging`
- `make CONFIRM=yes db-migrate-prod`

Each target requires the matching `db-proxy-<env>` to be running
in a separate terminal.

# Seed scripts

This directory collects per-module seed scripts for local development. `make db:seed` runs `scripts/seed/index.ts`, which invokes every registered seed in dependency order.

## Pattern

- One subdirectory per module: `scripts/seed/f01/`, `scripts/seed/d01/`, etc.
- Each exports a default `async function seed(ctx: SeedContext): Promise<void>`.
- Idempotent — re-running a seed must not duplicate rows. Prefer `INSERT … ON CONFLICT` or check-then-insert.
- Tenant-scoped seeds accept a `tenantId` param and respect F01 RLS.
- Destructive reset goes in `make reset`, not in `make db:seed`.

## Registering a new seed

1. Create `scripts/seed/<module-id>/index.ts` exporting `default async function seed(ctx)`.
2. Add the module to the `SEEDS` array in `scripts/seed/index.ts`, declaring its upstream deps so order is stable.
3. Run `make db:seed` locally to verify idempotency (run twice — second run must not error or duplicate).

## Safety rail

`scripts/seed/index.ts` parses `DATABASE_URL` and refuses to run against any host other than `localhost`, `127.0.0.1`, or `::1`. Seeds are local-development-only; production data comes from the tenant provisioning pipeline (F02), not from this directory.

## Out of scope

- Demo-tenant data for Display Data lives under `scripts/display-data/`, registered in P11.1. Do not put Display Data demo data here.
- Synthetic data for agent testing lives under `/agents/*/test-fixtures/`, registered in P10.6.

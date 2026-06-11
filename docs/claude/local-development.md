# Local development

> Relocated from CLAUDE.md for context-budget; loaded on demand.

Local test runs target the compose Postgres in `infra/dev/docker-compose.yml`. Its env (user/password/DB) is realigned to mirror `.github/workflows/ci.yaml` exactly: `postgres` / `testpw` / `cortex`. Same image (`pgvector/pgvector:pg17`), same bootstrap (non-superuser `test_user` with `audit_event` ownership transfer). Local bugs and CI bugs surface the same way.

### Local test setup

1. **`make db:init-test`** — boots compose Postgres, applies migrations via `pnpm db:migrate`, creates `test_user` (NOSUPERUSER NOBYPASSRLS), transfers `audit_event` ownership to it. Idempotent — safe to re-run after migration changes. Required before first test run.
2. **`pnpm vitest run`** — runs all tests against local compose Postgres. Mirrors CI exactly. Tests connect via PG\* env vars; `PGPASSWORD=testpw` is now MANDATORY (no gcloud-secret fallback — it masked setup errors).
3. **`make db:shell`** — psql into the local DB (postgres user, cortex DB) for inspection.

### One-time after pulling roadmap §4.20 closure

`docker-compose down -v` before the next `make db:init-test`. The compose Postgres' user / password / DB changed; a stale data volume initialized with the previous credentials will reject the new bootstrap. Local-only — no production-data implication. Operator coordinates the volume reset across the team.

### Why `PGPASSWORD` is mandatory

`@cortex/test-db-harness`'s `getPool()` throws if `PGPASSWORD` is unset rather than fetching from a gcloud secret as a fallback. The fallback (removed in §4.20 closure) silently fetched the **dev Cloud SQL** break-glass password and tried it against the **local docker** container — which never matched. Fail-fast with a clear error beats silent setup drift.

### Pre-push test verification env-loading

The test-db-harness reads `PG*` env vars from `process.env` directly (`PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`). It does NOT auto-load `.env.local` — vitest runs without env unless the shell has them set. Running `pnpm test` from a fresh shell without env produces clean "PGPASSWORD not set" errors and tests skip at file-level `beforeAll`.

Local pre-push verification pattern:

```bash
set -a && source .env.local && set +a
(cd packages/<pkg> && pnpm test --run --no-file-parallelism)
```

`set -a` / `set +a` auto-exports every variable assigned between them, so plain `KEY=value` lines in `.env.local` become exported `process.env` entries. Without this bracket, tests skip silently.

CI doesn't need this — `.github/workflows/ci.yaml`'s `services` block sets env vars directly on the GHA runner.

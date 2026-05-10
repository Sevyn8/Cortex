# Cortex — Claude Code instructions

## Spec-first workflow

- Read `/docs/spec/cortex_v2.2.docx` before implementing any module or screen
- Every functional requirement (FR-NNN) in a spec section has at least one test
- Spec drift: update the spec OR update the code, never leave drift uncommented
- Significant divergence → ADR in `/docs/architecture/decisions/`

## Coding conventions

- TypeScript strict. No implicit any. No @ts-ignore without ADR reference.
- Functions < 40 lines; files < 400 lines (soft limits — flag violations in PR review)
- No business logic in controllers/routes. Thin HTTP handlers → service layer → repository
- Zod schemas for every API input and output
- No `console.log`; use `@cortex/observability` logger

## Commit conventions

- Conventional commits. Types: feat, fix, docs, refactor, test, chore, ops
- Scope = module ID (lowercase): `feat(f01): ...`
- Include prompt ID in commit body: `Prompt: P1.1`
- Reference spec section: `Spec: §F01-FR-003`

### Co-Authored-By trailer

Commit messages MUST NOT include `Co-Authored-By: Claude` or any AI co-author trailer unless the operator explicitly requests one in the current turn. Default to no trailer. This applies to all squash bodies, single commits, and amended commits without exception.

### WIP commits

When a slice breaks across sessions, stage progress as a WIP commit on the slice branch (do not push). The WIP commit squashes away at HOLD #3 squash composition.

Commit shape: `chore(<scope>): wip <description>`

- Type MUST be one of the commitlint-allowed types (`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ops` / `perf` / `style` / `build` / `ci` / `revert`). `wip` is NOT an allowed type and will be rejected by commitlint with `type-enum`.
- Subject body MUST be lowercase even for module IDs (`D.1-D.4` fails `subject-case`; `d.1-d.4` passes).
- Body documents the WIP state (what's done, what's pending, self-verify status — pre-existing-tests passing, typecheck clean, etc.).
- DO NOT push the WIP commit; it lives on the local slice branch only and squashes into the final `feat(...)` at HOLD #3 composition.

Example:

```
chore(f04-d): wip d.1-d.4 impact analysis substrate + lifecycle wiring

Mid-build WIP commit at HOLD #2 per operator session-break.
Will be squashed into the final feat(F04-D) commit at HOLD #3
composition. Working tree state is verifiable:
  - 89/89 config-plane tests passing
  - typecheck across 30 packages clean
  ...
```

Lesson surfaced PR #N (Slice D HOLD #2): operator's draft used `wip(...)` as the type and uppercase `D.1-D.4` in the subject — both rejected by commitlint. The fix retained body verbatim with type=`chore` + lowercase subject.

## Branching & PR

### Trunk-based with mandatory PR gating

Main is protected. Direct pushes are blocked. All changes — including chores, docs, and trivial fixes — go through a feature branch + PR + CI-green gate. CI is the only gate; no human review required for solo-dev velocity.

### Standard workflow per change

1. `git checkout -b <branch-name>` — branch naming follows existing convention (slice branches as `pX.Y-fNN-slice-Z`, fixes as `fix-<slug>`, chores as `chore-<slug>`).
2. Local verification — `pnpm vitest run` against compose Postgres. Must pass before push. (Roadmap §4.20 closed 2026-05-09 — `make db:init-test` brings the local stack up; see `## Local development`.)
3. `git push -u origin <branch-name>`
4. `gh pr create --fill --base main`
5. Wait for CI on the PR. Required check: `Run foundation tests against ephemeral Postgres`.
6. After CI green: `gh pr merge --merge --delete-branch` (or `--squash --delete-branch` for slice-style multi-commit branches that should land as one squashed commit).
7. Pull main locally: `git checkout main && git pull`.

### Why no admin bypass

Carried red CI on D.6 for 3 slices. The bypass was structural, not procedural — `enforce_admins` was `false`. Closed 2026-05-09 along with §4.20. See `docs/planning/branch-protection-2026-05-09.md` for the audit trail.

### Solo-dev review note

GitHub's PR-author-cannot-approve rule means human review would block on a second seat. Configuration deliberately requires NO human review (`required_approving_review_count: 0`) — CI is sufficient. Two-person review remains a social convention for high-stakes changes (architectural pivots, schema migrations affecting prod data, security-sensitive code). Operator's judgment.

## Local development

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

## Audit events

- Follow `/docs/architecture/audit-event-convention.md`
- Every mutating service method emits an audit event via `@cortex/audit-events`

### P0.10+ — library-driven emission

Compliance audit chain lives in `@cortex/audit-events`. Modules emit via `emitAuditEvent(tx, params)` from a tenant-bound transaction. Each module owns its action catalog (declared via `registerAuditActions([...] as const)` in a side-effect-free file like `audit-actions.ts`).

Verb-driven discriminated union enforces before/after-state requirements at compile time: CREATE → `after_state` only, UPDATE → both, DELETE → `before_state` only, READ → neither, APPROVE/REJECT/EXECUTE → caller's choice. The library auto-stamps `occurred_at = clock_timestamp()` per planning-doc Decision 11; callers don't supply it. Payload uses snake_case on the wire (TS API uses camelCase) — canonicalization handles the mapping.

When emitting from a new module, see `/docs/architecture/audit-event-convention.md` for the full pattern. Recurring gotchas:

- Optional fields (`actorDescription`, `sessionId`, etc.) require conditional spread under `exactOptionalPropertyTypes` — passing `undefined` is rejected; the field must be omitted.
- `@cortex/observability` is imported **statically** (`import { createLogger } from '@cortex/observability'`). The dynamic-import-as-cycle-defense pattern from the P0.10/Slice B era is **retired** (resolved 2026-04-27 by `ebb14ca` — see roadmap §4.13). Both `@cortex/observability` AND `@cortex/audit-events` are leaves w.r.t. `@cortex/tenant-context` — neither imports it at runtime OR in test deps. New packages downstream of tenant-context must preserve the same leafness on both halves; turbo's package-graph view counts `devDependencies`.
- `defaultContextProvider` from `@cortex/observability` does NOT auto-resolve `tenant_id`. Apps wanting `tenant_id` in log fields explicitly compose `tenantContextProvider` from `@cortex/tenant-context` via `composeContextProviders` at startup: `createLogger({ contextProvider: composeContextProviders(defaultContextProvider, tenantContextProvider) })`. Libraries do NOT compose; they accept whatever `ContextProvider` their caller supplies via `createLogger` options.
- `vi.mock` targets must be side-effect-free at top level. Catalog declarations belong in a separate file (`audit-actions.ts` precedent in `@cortex/tenant-context`).
- Caller MUST `bindTenantToDbSession(tx, tenantId)` before `emitAuditEvent(tx, ...)` — without it, RLS denies the INSERT (SQLSTATE 42501) and surfaces as `AuditEventEmissionError`.

References: ADR-AU-001 (library shape), ADR-DB-003 (chain integrity), planning doc `docs/planning/p0-10-audit-events-scope.md` Decisions 1–11, roadmap §4.12 (Pub/Sub fan-out, deferred), §4.13 (observability ↔ tenant-context decoupling, **resolved 2026-04-27 / commit `ebb14ca`**).

## Encryption + Blob Storage (F01 Slice B+)

PII encryption uses `@cortex/encryption` (envelope encryption with tenant-id AAD). Tenant-scoped blob storage uses `@cortex/blob-storage` (path-prefix isolation, pre-signed URLs).

The substrate: `tenant_kms_key` table per ADR-INFRA-007 — provisioned at tenant creation, currently points at the env's `cortex-general-key` (Phase 1); F02 swaps to real per-tenant keys without changing envelope format. AAD-bound envelopes (`utf8(tenantId)`) are the cryptographic isolation primitive — cross-tenant decrypt fails at the AEAD auth-tag regardless of which key the resolver returns.

GCS substrate: `cortex-{env}-tenant-data` bucket with bucket-level CMEK + `tenant-data-runtime` SA. Object-key isolation via `tenants/{tenantId}/{...}` prefix; cross-tenant escape protection at application layer (`@cortex/blob-storage` path validators — `buildFullObjectPath`, `assertObjectInTenantPrefix`). NEVER concatenate tenant prefixes manually.

**CRITICAL gotcha:** any new CMEK-encrypted GCS bucket needs the GCS PROJECT SERVICE AGENT IAM grant on the KMS key — `service-{project_number}@gs-project-accounts.iam.gserviceaccount.com` with `roles/cloudkms.cryptoKeyEncrypterDecrypter`. The runtime SA grant is for object-level I/O; the service-agent grant is for bucket-level CMEK encryption. Both required. Use `data "google_storage_project_service_account"` (not `google_project_service_identity` — the latter returns `.email = null` for already-materialized agents per ADR-INFRA-002 Quirk 1). Bucket's `depends_on` MUST include the GCS-agent grant. Worked example: `infra/terraform/modules/tenant-data-bucket/main.tf`.

When emitting from a new module, see `/docs/architecture/encryption-blob-storage-convention.md` for the full pattern. Recurring gotchas:

- Use verb `CREATE` for derivative artifacts (`PII_ENCRYPTED` is the canonical example) — the derivative is being created even if the underlying entity existed before.
- Service-actor in Phase 1 is hardcoded `'cortex-encryption'`; AC01 will swap to a request-scoped resolver (roadmap §4.14).
- `@cortex/encryption` warns at 64 KB envelope size; `@cortex/audit-events` warns at 64 KB canonicalized payload size — independent thresholds.
- Don't mix env-defaulted helpers (`generateSignedUrl`) with explicit-env helpers (`createSignedUrlSigner(env)`) in the same call path.
- For `expect(spy).toHaveBeenCalled*()` with `vi.fn()`: hoist the spy to a variable; using `expect(obj.method).toHaveBeenCalled()` trips `@typescript-eslint/unbound-method`.
- `gcloud storage buckets describe` returns `null` for several config fields — verify via `gsutil ls -L gs://...` or the storage v1 REST API.

References: ADR-INFRA-004 (env-level CMEK), ADR-INFRA-007 (per-tenant CMEK migration path), ADR-AU-001 (audit emission), planning doc `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md`, convention doc `docs/architecture/encryption-blob-storage-convention.md`.

## Quotas + Compute Placement (F01 Slice C)

`@cortex/quotas`: token bucket per `(tenant, resource_class)` backed by `tenant_quota_usage`; HTTP middleware (framework-agnostic + Hono / Express adapters); 429 + `Retry-After` + `QUOTA_EXCEEDED` audit on every rejection.

`@cortex/compute-placement`: `getComputePlacement(tenantId, workload, env)` returns `ComputePlacement` (`shared` | `dedicated`). Phase 1 always shared; F02 will branch on `tenant.tier`.

Key conventions:

- Library returns `CheckQuotaResult`; does NOT throw on exceedance (throwing rolls back the audit row that just emitted). `QuotaExceededError` class exists for callers wanting throw-semantics — they construct manually from the result.
- `REJECT` verb covers both workflow-rejections AND throughput-rejections (quota, rate limit, circuit breaker). Audit consumers filter by action name to disambiguate.
- BigInt at API boundaries: `String()` before `JSON.stringify`, before pino, before HTTP response body. `pg` returns `bigint` as string for raw `db.execute()` — explicit `BigInt()` coercion at boundary.
- Cloud Run service names: `{workload}-shared` / `{workload}-tenant-{uuid}`; 19-char workload max; `env` in GCP project path, NOT in service name.
- `placement` label (`shared` | `dedicated`) is **deployment shape**, NOT commercial tier. `tenant.tier` (`STANDARD` | `ENTERPRISE`) is the commercial tier; lives in DB.
- Pre-check semantics for `api_calls` / `db_connections` (middleware fires `resolveIncrement` before request); post-emit pattern for `cpu_seconds` / `ram_mb` (call `checkQuota` directly after work completes).
- `db_connections` counts connections opened per minute (NOT concurrent). True concurrent-limiting belongs in PgBouncer / connection-pool layer.
- Strict-greater (`>`) for "exceeded" — request landing AT the limit passes; only over-the-limit rejects. Industry convention.
- Default per-tier quotas are TUNABLE baselines, not load-derived. Adjust via F02 `tenant_config_version` overrides, NOT by widening the constants.

References: ADR-COMPUTE-001 (Cloud Run vs K8s), ADR-INFRA-007 (substrate-now precedent), ADR-AU-001 (audit emission), planning doc `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`, convention doc `docs/architecture/quotas-compute-placement-convention.md`, F02 swap doc `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md`.

## Error responses

- Standard shape: `{ code, message, correlation_id, details? }`
- HTTP status alignment: 400 VALIDATION, 401 UNAUTH, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT, 422 BUSINESS_RULE, 429 RATE_LIMIT, 500 INTERNAL
- Use `@cortex/http-errors` package

## Testing

- Unit test coverage: 80% line / 70% branch minimum
- Every acceptance criterion from spec → at least one test
- Regression tests required for bug fixes
- Every widget and screen passes axe-core (WCAG 2.1 AA)

## Stack constraints

- Auth: WorkOS (not Auth0, not self-hosted)
- ORM: Drizzle (not Prisma, not raw pg)
- Monorepo: Turborepo (not Nx)
- CSS: Tailwind 4 with CSS vars for theming
- Node: 22 LTS
- Package manager: pnpm

## Workspace layout

The `services/` tree contains both patterns:

- **Top-level services** at `services/<name>/` — cross-cutting services that don't belong to a feature category (e.g., `services/foundation/`).
- **Categorized services** at `services/<category>/<name>/` — grouped under feature domains (e.g., `services/access/ac01/`).

`pnpm-workspace.yaml` globs both `services/*` and `services/*/*`. Avoid mixing: a service at `services/foundation/package.json` cannot also have `services/foundation/<sub>/package.json` — the two globs would double-match and pnpm would reject.

### `apps/<workload>-api/` — control-plane HTTP services

Cortex control-plane HTTP workloads (e.g., `apps/tenant-lifecycle-api/` shipped in F02 Slice D) follow a Hono + workspace-deps pattern:

- **Hono app + workspace deps.** `package.json` declares `hono`, `@hono/zod-validator`, `hono-pino`, `hono-problem-details` + the `@cortex/*` workspace deps the workload consumes. `tsconfig.build.json` for `dist/` emit; `tsconfig.json` for typecheck/lint includes `test/`.
- **Parallel `src/` + `test/` shape.** `src/{app,config,error-mapper,observability}.ts` + `src/routes/{health,test,v1/tenants,workers/<verb>}.ts`; tests mirror at `test/routes/...`. Worker routes (`/v1/_workers/<verb>`) live alongside user routes but bypass the user-tenant-context middleware via `skipPaths` — see convention §7.4.0 for the OIDC-validated worker-route shape.
- **`scripts/deploy-{env}.sh` for image-only updates.** Service shape is TF-owned (per `infra/terraform/modules/tenant-cloud-run-service/`); deploy scripts only call `gcloud run services update --image=<sha-tagged>`. NO `--service-account`, `--port`, `--cpu`, `--memory`, `--labels` — those flags fight TF on subsequent applies. Image bootstrap via `make image-bootstrap APP=<workload>`. Convention §7.4.0 deploy-checklist captures the full new-workload sequence.

## Turbo env var passthrough

Turbo 2.x runs in strict env mode by default. Env vars are stripped from task
child processes unless explicitly declared:

- `task.env[]` — passes through AND includes in cache key (use for vars that
  change behavior, like PGHOST)
- `task.passThroughEnv[]` — passes through WITHOUT affecting cache key (use
  for secrets/tokens that shouldn't invalidate cache)
- `globalPassThroughEnv[]` — same but repo-wide

Forgetting this manifests as surprising `undefined` env vars in test/build
processes despite them being set at the shell or CI level. See `turbo.json`'s
`test.env` for the pattern.

First time encountered: P0.5 Phase 2C ci.yaml first-run — Postgres env vars
set at GHA job level weren't reaching vitest subprocess via `pnpm test` →
`turbo test` → `vitest`.

## Database conventions

Phase 1 database posture — raw-SQL migrations, bi-temporal primitives, RLS, audit chain.
Deep rationale lives in ADR-DB-001, DB-002, DB-003.

### Migrations

- Raw SQL files in `services/foundation/migrations/`, run by `drizzle-kit migrate`. Drizzle `pgTable` schemas are for app-side typed queries only — not the source of truth for migrations.
- Apply via `make db-migrate-{dev,staging,prod}` (wraps `pnpm db:migrate` with gcloud-injected `PGPASSWORD`). Requires matching `make db-proxy-<env>` in another terminal.
- **Write and apply one migration at a time.** Author SQL → append journal entry with fresh `Date.now()` → apply → test → commit. The `when` field in `_journal.json` is a high-water mark: placeholder files with later `when` values silently block earlier-timestamped edits from ever applying.
- First-consumer principle: helpers like `as_of_valid`, `verify_chain`, advisory locks are **deferred until a service needs them**. Ship the primitive (`at_time_t` predicate; `audit_canonical_hash` function), not the full API surface. See ADR-DB-001 §3 "Deferred helpers", ADR-DB-003 Impl Notes.

### Session variables

- Tenant context flows via `app.tenant_id` (uuid) set per-transaction by F01 middleware (P1.1, not yet built). `cortex.current_tenant_id()` reads it; NULL / empty / invalid → SQLSTATE `42501` fail-closed. See ADR-DB-002.
- **`SET LOCAL` does NOT accept bind parameters** — `SET LOCAL app.tenant_id = $1` raises SQLSTATE `42601`. Use the functional form:
  ```sql
  SELECT set_config('app.tenant_id', $1, true);  -- is_local = true ≡ SET LOCAL
  ```
- Always `SET LOCAL` or `set_config(..., true)` — never `SET SESSION` (leaks across pooled connections).

### Canonical timestamps + hashing

- Postgres `timestamptz` has microsecond precision; JS `Date` has millisecond precision. The default `pg` type parser converts on fetch, silently dropping 3 decimal digits on round-trip.
- **Hash / signature computations over timestamps must be done server-side** (or use a string-preserving `pg` type parser). Sending a JS Date back as `$N::timestamptz` reconstructs with zero-padded µs, changing the canonical form and invalidating the hash.
- Canonical literal for hashing is UTC ISO-8601 µs:
  ```sql
  to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ```
  See `cortex.audit_canonical_hash` (ADR-DB-003 §3).

### Append-only tables

- `audit_event` enforces append-only via a `BEFORE INSERT OR UPDATE OR DELETE` trigger. UPDATE/DELETE raise SQLSTATE `2F002` regardless of role. See ADR-DB-003 §4.
- **TRUNCATE bypasses ROW triggers** — Postgres fires STATEMENT-level triggers on TRUNCATE, not per-row ones. Production service roles must not hold `TRUNCATE` privilege on `audit_event`; dev test setup uses TRUNCATE deliberately for idempotency.
- If absolute append-only is ever required end-to-end, add a `BEFORE TRUNCATE` STATEMENT trigger raising `2F002`.

### `audit_event` row shape

`audit_event` rows wrap event metadata in a `payload` jsonb column (NOT a top-level `after_state` column). Test queries reading audit metadata access via:

```sql
SELECT payload -> 'after_state' ->> 'field' AS field
FROM audit_event WHERE ...
```

The payload jsonb's typical shape:

```json
{
  "before_state": { ... },
  "after_state": { ... },
  ... action-specific fields the emitter populated
}
```

When asserting test expectations on audit metadata, query the payload path directly. Don't assume top-level columns. The actual `audit_event` columns are: `event_id`, `tenant_id`, `actor_type`, `actor_id`, `actor_description`, `action`, `resource`, `payload`, `occurred_at`, `prev_hash`, `curr_hash`, `inserted_at` — only `payload` carries the structured emit data.

### `audit_event` cleanup limitations

`audit_event` has the append-only trigger above that rejects DELETE with SQLSTATE `2F002`. Helpers like `cleanupConfigPlaneState`'s `DELETE FROM audit_event` wrap their query in `.catch(() => undefined)` and silently swallow the failure — so audit rows leak across tests within a session.

Test fixtures must compensate by being defensive in their audit assertions:

- Filter by `tenant_id` AND a test-unique payload field (e.g., `payload -> 'after_state' ->> 'from_draft_id' = $draftId`) to scope queries to the current test's emissions.
- Use `ORDER BY occurred_at DESC LIMIT 1` for "most recent" reads; this naturally returns the current test's row even when older runs left rows for the same tenant.
- For "no rows should exist" assertions, ALWAYS combine `WHERE tenant_id = $1 AND <test-unique field>` — a bare action-name filter will surface false positives from prior tests' rows.

Not filtering this way will surface false positives. Tracked at roadmap §1.15 (cleanup-helper improvement candidates).

### Multi-tenant test isolation via RLS

Multi-tenant isolation tests should EXPLOIT the RLS policy rather than fabricating isolation:

```ts
// Bind tenant B's context; query data created by tenant A
await inTenant(db, tenantB, async (tx) => {
  // Tenant A's drafts/configs are RLS-filtered out.
  // Asserting "not found" naturally validates isolation.
  await expect(analyzeImpact(tx, tenantB, draftIdFromTenantA)).rejects.toThrow(
    ImpactAnalysisDraftNotFoundError,
  );
});
```

RLS does the isolation work; the test verifies the policy enforces it. Canonical multi-tenant test pattern; surface for any future module's tests. F04 Slice D's `impact-analysis.spec.ts` shows the pattern in `analyzeImpact — end-to-end > multi-tenant isolation` test.

### Testing RLS-protected tables

- Vitest runs as `postgres` (superuser). By default, table owners bypass RLS — policy tests would silently pass without enforcing anything.
- Set `ALTER TABLE <t> FORCE ROW LEVEL SECURITY` in `beforeAll`, pair with `NO FORCE` in `afterAll`. Real Phase 1 tables do NOT need FORCE in production (F01 middleware never runs as superuser).
- Use `withTenantContext(pool, tenantId, fn)` / `withoutTenantContext(pool, fn)` from `@cortex/canonical-schema/rls-test` to set / unset tenant context inside a test transaction. The helpers use `set_config` under the hood for the reason in the "Session variables" section above.

### Test-fixture tables need explicit GRANTs

CI bootstrap (`scripts/db-reset-local.sh`) runs `GRANT ALL ON ALL TABLES IN SCHEMA public TO test_user` once. **Tables created in `beforeAll` AFTER bootstrap don't inherit that grant.** Each fixture table needs an explicit `GRANT` after `CREATE TABLE`:

```ts
await pool.query('CREATE TABLE my_fixture (...)');
await pool.query('GRANT ALL ON my_fixture TO test_user');
```

Without it, tests using `withTenantContext` (which connects as `test_user`) fail with `permission denied for table my_fixture`. This pattern has bitten F04 Slice B (lifecycle tests) and F03 Slice C (SCD policy trigger tests) — second-time discovery is the codification trigger. New fixture-creation helpers should bake the GRANT in by default.

### PL/pgSQL trigger row-type preservation

When dispatching dynamically on column names in a PL/pgSQL trigger, **avoid reassigning `NEW` via `EXECUTE INTO`**:

```sql
-- WRONG: NEW becomes a generic `record` type; later NEW.id := ... fails
-- with "record NEW has no field id"
EXECUTE format('SELECT jsonb_populate_record(NULL::%I.%I, $1)',
               TG_TABLE_SCHEMA, TG_TABLE_NAME)
  INTO NEW USING new_jsonb;
```

Dynamic SQL `INTO NEW` loses the trigger-row's typed-field info. Instead, use the **direct form** with `NEW` itself as the template-record:

```sql
-- CORRECT: passing NEW as the template preserves the trigger-row type
NEW := jsonb_populate_record(
  NEW,
  jsonb_build_object(sibling_col, to_jsonb(OLD) -> source_col)
);
```

`jsonb_populate_record(template anyelement, jsonb)` returns the same type as `template`. Passing `NEW` keeps NEW typed as the table's row, so subsequent `NEW.<field> := ...` access works. Avoid dynamic SQL when the static form suffices.

Discovered during F03 Slice C migration 0017 trigger work.

### Reshaping tenant-scoped substrate tables

When migrating a tenant-scoped table from monolithic-per-tenant to per-(tenant, namespace) (or any analogous "split a single row into per-key rows"), pre-enumerate the reconciliation surface workspace-wide. **Three classes** to grep:

1. **INSERT sites** (raw SQL + Drizzle `insert(...)`) — every writer needs the new column.
2. **SELECT sites that returned "the only row" or "the latest row"** per tenant — they now need namespace filters to preserve semantics. **This class fails quietly** at planning time; a `INSERT INTO <table>` grep won't find it because it's a SELECT.
3. **Drizzle ORM calls** (`from(...)`, `insert(...)`, `update(...)`) — raw-SQL grep misses these.

```bash
grep -rn "INSERT INTO <table>\|FROM <table>" workspace
grep -rn "insert(<drizzleTableName>)\|from(<drizzleTableName>)" workspace
```

Pre-push verification for substrate-table reshape commits MUST be `pnpm vitest run` **workspace-wide**, not a scoped subset. Read-class failures only surface when fixtures from other namespaces exist; CI is the fallback if local skips them.

**Workspace-wide test runner caveat.** `pnpm test` workspace-wide runs vitest in turbo-parallel mode and hits a pre-existing race involving `audit-chain.spec.ts`'s FORCE RLS toggle racing with parallel suites' `audit_event` INSERTs. The race is timing-dependent and apparently doesn't manifest in CI. Locally, fall back to per-package serial (run vitest in each affected package's directory) as the reliable pre-push gate; CI is the canonical workspace-wide gate. Tracked for fix at `docs/future-roadmap.md` §1.13.

Pad reshape-reconciliation estimates to 2× the source-file-only estimate. Slice A's 1-hr A.6 estimate landed at ~1.5 hr after counting the test-fixture surface (+~30 min) and the CI-caught read-class fix (+~30 min).

Reference: `docs/planning/p1.4-f04-configuration-plane-scope.md` §5 Risk Register (Slice A's reconciliation discovery, including the quotas reads class missed by the original grep).

### Bi-temporal table convention `[F03 Slice A]`

When a tenant-scoped table is a domain entity (retains valid-time + transaction-time history per ADR-DB-001), use the bi-temporal pattern. When it's bookkeeping (queue, counter, lookup, append-only audit log), it isn't bi-temporal.

**When to use:** domain entities under `tenant_id` with versioning needs (products, hierarchy nodes, facts, etc.).

**When NOT to use** (allowlist of bookkeeping tables — never bi-temporal): `tenant`, `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`, `legal_hold`, `audit_event`. New bookkeeping tables: opt out by adding a directive immediately before `CREATE TABLE`:

```sql
-- @bi-temporal: skip
CREATE TABLE my_bookkeeping_table ( ... );
```

The lint enforces fail-closed — a tenant-scoped (`tenant_id`-bearing) table that is not in the allowlist AND lacks the directive AND lacks the recipe → CI fail. Pre-commit hook (`lint-staged`) catches at commit time; `.github/workflows/ci.yaml`'s `Lint bi-temporal migrations` step catches `--no-verify` bypasses.

**Recipe** (post-0006 trigger binding; cross-ref migration 0006 for the ms-precision normalization that makes JS-Date round-trip lossless):

- Two `tstzrange` columns: `valid_time` + `txn_time`
- Trigger: `BEFORE INSERT OR UPDATE OR DELETE` calling `cortex.cortex_scd_trigger()`
- GiST index on `(tenant_id, valid_time, txn_time)`
- Current-version partial index `WHERE upper(txn_time) IS NULL`
- Exclusion constraint on `(tenant_id, business_key, valid_time)` `WHERE upper(txn_time) IS NULL`

**Scaffold** (preferred; produces the recipe SQL ready to redirect into a migration file):

```bash
make db-scaffold-bitemporal TABLE=<name> BUSINESS_KEY=<col> [WITH_WRAPPERS=y|n]
```

The `WITH_WRAPPERS` flag generates per-table query wrappers (`cortex.<table>_as_of_valid`, `cortex.<table>_as_of_latest`, `cortex.<table>_history`) over the shared `cortex.at_time_t` predicate. Defaults to `y`.

- `WITH_WRAPPERS=y` (default; almost always): generates the 3 wrappers. Locks per-table query shape consistent across all bi-temporal tables; new consumers don't redo the design call. Closes roadmap §5.2 on a per-table basis as scaffolds run.
- `WITH_WRAPPERS=n` (rare): generates columns + trigger + indexes only. Use when the access pattern hasn't been designed yet AND the table needs to ship bi-temporal for future-compat. The wrappers can be added later via a follow-up migration. ADR-DB-001 §Implementation Notes deferral pattern remains the fallback.

The scaffold writes to stdout; redirect to a migration file path of your choosing. The scaffold deliberately does NOT touch `services/foundation/migrations/meta/_journal.json` — append the journal entry manually per the high-water-mark discipline (ADR-DB-001 §Implementation Notes).

**Backfill** (legacy tables that exist without bi-temporal columns):

```sql
SELECT cortex.backfill_bitemporal('public', 'tablename', 'business_key_col');
```

Idempotent — re-running on an already-backfilled table is a no-op. Currently zero legacy tables in the codebase need this; the helper future-proofs reclassification (a bookkeeping table that becomes domain) and external imports.

**Querying bi-temporal data** — use `@cortex/temporal-query` (F03 Slice B + B.5). Composable functions over `cortex.at_time_t`:

Row-version (id-based; Slice B):

- `asOf<T>(client, tenantId, table, id, asOfBusinessTs, asOfSystemTs?) → BiTemporalRow<T> | null`
- `currentState<T>(client, tenantId, table, id) → BiTemporalRow<T> | null`
- `history<T>(client, tenantId, table, id) → BiTemporalRow<T>[]`
- `between<T>(client, tenantId, table, id, from, to, asOfSystemTs?) → BiTemporalRow<T>[]` — closed-open `[from, to)`
- `diff<T>(client, tenantId, table, id, t1, t2) → { before, after, changedColumns }` — `@experimental`; see caveat below

Entity-level (business-key-based; Slice B.5):

- `asOfByKey<T>(client, tenantId, table, keyColumn, keyValue, asOfBusinessTs, asOfSystemTs?) → BiTemporalRow<T> | null`
- `diffByKey<T>(client, tenantId, table, keyColumn, keyValue, t1, t2) → { before, after, changedColumns }`

Public API takes a `Queryable` interface (Q-NEW-F03B-5; productization-critical lock) — `pg.Pool`, `pg.PoolClient`, drizzle's underlying client, and test mocks all satisfy it. `tenantId` passed as a query parameter on every call (Q-NEW-F03B-6); RLS stays as defense-in-depth backstop. Returns are nullable for single-row functions (`null` on no match) and `T[]` (never `null`) for collection functions. Closed-open ranges throughout (matches `tstzrange` convention end-to-end). tRPC handlers + SQL views deferred to first-consumer per Q-NEW-F03B-1; tRPC will land in `@cortex/temporal-query/trpc` secondary export, SQL views land per-table at the consuming F-/D-series migration's site.

**Table-name validation:** the `table` argument to all 5 functions must match `/^[a-z][a-z0-9_]{0,62}$/` — snake*case identifier, 1–63 chars (Postgres `NAMEDATALEN-1` limit). Lowercase first char, then `[a-z0-9*]`. **Generic regex, NOT an allowlist** of known bi-temporal tables — no maintenance surface as new bi-temporal tables land. Names that don't match throw at the call site (`temporal-query: invalid table name ...`). Table names cannot be parameterized in Postgres prepared statements; the regex is the SQL-injection guard.

**`asOf` system-anchor default — closed prior versions need explicit `asOfSystemTs`.** The default `asOfSystemTs = now()` reaches only the row whose `txn_time` is currently OPEN. Prior-version rows closed by an SCD trigger UPDATE (which sets the OLD row's `txn_time` upper bound to `now()` AT THAT MOMENT) require an explicit past system-anchor — typically `asOfSystemTs = asOfBusinessTs` for "what was the world state at moment T". Worked example in `packages/temporal-query/src/as-of.ts` JSDoc. The asymmetric default surprised an experienced operator on first attempt; the explicit-anchor pattern is now part of the contract docs.

**`diff` is row-version scoped (`@experimental`).** It operates on a specific row id, comparing the SAME row at two timestamps. For entity-level diff across business identity (the headline F03 "what changed about this product over time" use case), use **`diffByKey`** — same shape, but resolves the entity at each timestamp via `(tenant_id, keyColumn = keyValue)`. The row-version `diff` primitive is useful for narrow scenarios — correction histories, txn_time-axis comparisons within a single row generation, no-change verification — and is NOT the right tool for "show me what changed about this product over time." The SCD trigger rotates `id` on UPDATE (`NEW.id := gen_random_uuid()`), so cross-version comparison via the row-version primitive requires a business-key resolver — which `diffByKey` provides.

**`diffByKey` defaults SYMMETRIC (historical-snapshot mode); `diff` defaults `systemAnchor=now`.** This asymmetry is deliberate. Each `t1` / `t2` passed to `diffByKey` is treated as BOTH the business AND system anchor inside the internal `asOfByKey` calls — i.e., "what did the system know at t1 about the world at t1?". Row-version `diff` defaults each anchor's system axis to `now()`, which is the source of the F03 spec acceptance test bug closed in commit `a7c9a23`. The entity-level diff's symmetric default avoids that surprise structurally — the headline use case is comparing snapshots, so the natural default IS historical-snapshot. Both behaviors documented in JSDoc + this CLAUDE.md callout.

**`asOfByKey` keeps `asOf`'s asymmetric default** (`systemAnchor = now()`) because the single-anchor query has the same "current belief vs historical snapshot" choice that `asOf` does — passing only a business anchor reads "what does the system currently believe was true at businessTs". To reach a closed prior version (e.g., for a forensic replay), pass an explicit past system anchor — typically `asOfSystemTs = asOfBusinessTs`. Same idiom as `asOf`.

**`asOfByKey` / `diffByKey` throw on multi-row match (D13).** The substrate exclusion constraint on bi-temporal tables only enforces no-overlap on currently-OPEN rows (`WHERE upper(txn_time) IS NULL`). Closed historical rows can in principle overlap; if a multi-row match surfaces, the library throws with `temporal-query: multiple rows match (...) — substrate constraint violation; check SCD exclusion constraint on <table>.` Loud failure beats non-deterministic row selection — exposes upstream SCD bugs rather than masking them.

**Composite (multi-column) business keys are out of scope for Slice B.5.** `keyValue` is `string | number`. Most bi-temporal entities have single-column business keys (sku, customer_id, order_number). Multi-column composite-key support deferred to first-consumer per ADR-DB-001 deferral pattern.

**Cross-refs:**

- ADR-DB-001 (primary contract; recipe rationale + alternatives rejected — especially Alternative 4 (4-scalar columns) and Alternative 5 (named retrieval funcs as platform primitives))
- Migration 0002 (`cortex.cortex_scd_trigger` + `cortex.at_time_t`); the file's header recipe was post-0006-corrected in F03 Slice A.
- Migration 0006 (ms-precision quantum) — JS-Date round-trip safe.
- `docs/planning/f03-temporal-data-engine-scope.md` (multi-phase close timeline; tracks Slice C / D deferrals to F04 / D04)
- `docs/planning/f03-slice-A-scope.md` (SD-locked decisions, especially Q-NEW-F03A-1 `WITH_WRAPPERS` synthesis and SD5 lint scope)
- `packages/temporal-query/src/index.ts` (Slice B library; Q-NEW-F03B locks on Queryable, tenantId parameterization, nullable returns, closed-open ranges, diff shape)

## Configuration plane (F04)

`@cortex/config-plane` ships the tenant-facing config layer. Every tenant-scoped setting (theme tokens, i18n, feature flags, screen-registry overrides, hierarchy schema, retention policies, quality rule library, SCD policies, vertical-package selection) lives as versioned config in `tenant_config_version` with a per-namespace shape (`platform.*`, `tenant.*`, `workspace.*`).

**Storage substrate** (Slice A — landed migration 0014): row-per-`(tenant, namespace, version_number)`, append-only chain via `parent_version_id` self-FK, schema-version-pinned via `schema_version` so drafts created against v=1 keep validating against v=1 after v=2 ships. F02 provisioning seeds v=1 rows in the `tenant` namespace.

**Read API** (Slice A): `getConfig<T>(client, tenantId, namespace) → T | null`. Async; cache-hit semantics ship in Slice C. Single-namespace; layered resolution (`workspace → tenant → platform`) ships in Slice C. Schema validation against `(namespace, schema_version)` mandatory — throws `NamespaceSchemaNotRegisteredError` if no schema registered for the row's pinned version.

**Schema registry** (Slice A): `registerNamespaceSchema(namespace, schema, { version })` — call at consumer module init. **Schema version is EXPLICIT on registration**, NOT derived from package version (workspace packages stay at `0.0.0`). A namespace MAY have multiple registered schema versions simultaneously; lookup uses the row's pinned `schema_version`.

**Audit catalog** (Slice A registers; Slice B emits): 6 verbs in `packages/config-plane/src/audit-actions.ts`:

- `CONFIG_DRAFT_CREATED / UPDATED / VALIDATED / DISCARDED` — draft lifecycle (Slice B)
- `CONFIG_VERSION_PROMOTED / ROLLED_BACK` — version-chain mutations (Slice B)

**`TENANT_CONFIG_VERSION_CREATED` coexistence** (locked at Slice A HOLD #1 per Q-NEW-F04A-10): F02's existing `TENANT_CONFIG_VERSION_CREATED` (substrate-bootstrap event at v=1 provisioning) and F04 Slice B's `CONFIG_VERSION_PROMOTED` (user-driven event at lifecycle promote) coexist — different actors, triggers, contexts. Slice B does NOT deprecate the F02 event.

**Slices** (per `docs/planning/p1.4-f04-configuration-plane-scope.md`):

- A — Storage + Zod registry + read API ✓
- B — Lifecycle (draft / validate / promote / rollback) ✓ — F03 Slice C unblocks at this slice's close per D7
- C — Layered resolution + caching (in-process LRU + TTL; Redis distributed cache deferred to roadmap §1.12)
- D — Impact analysis + breaking-change blocker
- E — Git-sync stub + module wrap-up

### Lifecycle API (Slice B)

`@cortex/config-plane` ships six lifecycle helpers in `src/lifecycle.ts`. Each opens its own `db.transaction(...)` (matches F02 precedent), binds tenant context for RLS, performs the mutation, emits the appropriate audit event, and returns / throws as documented.

| Function                                | Verb   | Audit                        | Purpose                                                                                                                                                                                                                                         |
| --------------------------------------- | ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDraft(db, params)`               | CREATE | `CONFIG_DRAFT_CREATED`       | Insert active draft. Pre-checks schema registration. Substrate UNIQUE catches duplicate active draft per (tenant, namespace, author).                                                                                                           |
| `updateDraft(db, tenantId, params)`     | UPDATE | `CONFIG_DRAFT_UPDATED`       | Optimistic UPDATE on `expectedUpdatedAt`; mismatch → `DraftConcurrencyError`. Resets `validation_state` to `'unvalidated'`.                                                                                                                     |
| `validateDraft(db, tenantId, params)`   | READ   | `CONFIG_DRAFT_VALIDATED`     | Zod parse against pinned `schema_version`; persists outcome to draft row's `validation_state` + `validation_errors`. Idempotent.                                                                                                                |
| `promoteDraft(db, tenantId, params)`    | CREATE | `CONFIG_VERSION_PROMOTED`    | Defensive re-validate (Q-NEW-F04B-6); INSERT new `tenant_config_version` row with optimistic concurrency on `(tenant, namespace, version_number)` UNIQUE; UPDATE draft → `'promoted'` + `promoted_to_version_id`. Retries up to twice on 23505. |
| `rollbackVersion(db, tenantId, params)` | CREATE | `CONFIG_VERSION_ROLLED_BACK` | Whole-namespace per Q-NEW-F04B-3; INSERT new version copying parent's `config_json`; new row's `parent_version_id` points to the rolled-back-FROM version (chain integrity). Same retry-twice pattern as promote. NOT author-scoped.            |
| `discardDraft(db, tenantId, params)`    | DELETE | `CONFIG_DRAFT_DISCARDED`     | Mark `status='discarded'`. Author-only. Frees the (tenant, namespace, author) UNIQUE slot for a fresh draft.                                                                                                                                    |

**Actor parameter** (Q-NEW-F04B-8): all helpers take an `Actor` with `type ∈ {'user', 'service', 'system'}`. F02 precedent. `actor.id` becomes `created_by_user_id` for drafts (column name retained for workspace consistency; stores any actor's UUID).

**Author-only draft visibility** (D3 sub-lock pre-AC01): `updateDraft / validateDraft / discardDraft / promoteDraft` filter on `created_by_user_id = actor.id` in the SQL. Post-AC01, the RLS policy upgrades to reference `cortex.current_user_id()`; the explicit filter then becomes redundant defense-in-depth.

**Optimistic concurrency** (D13): both promote and rollback insert into `tenant_config_version`; the UNIQUE on `(tenant_id, namespace, version_number)` catches concurrent writers. Each helper retries the WHOLE transaction up to twice — Postgres aborts the transaction on first error, so retry must wrap the entire `db.transaction(...)` call (not just the INSERT). Two consecutive 23505s → `Promote-` / `RollbackConcurrencyError`. The audit row count = number of successful operations (not attempts) because the emit is post-INSERT inside the transaction; aborted attempts never emit.

**Schema-version pinning on drafts** (Q-NEW-F04B-9): `createDraft` requires explicit `schemaVersion: number`. The library exports `getLatestRegisteredVersion(namespace) → number` for callers who want "give me latest"; auto-resolving inside `createDraft` would produce a stale-validation footgun across schema-bump windows.

**Error roster** (7 classes, all suffixed `Error`, all exported from package barrel):

| Class                      | Origin                                       | Caller-decision typical                      |
| -------------------------- | -------------------------------------------- | -------------------------------------------- |
| `DraftConcurrencyError`    | optimistic UPDATE conflict on `updateDraft`  | HTTP 409; refresh + retry                    |
| `DraftNotFoundError`       | missing / not-active / wrong-author          | HTTP 404                                     |
| `SchemaNotRegisteredError` | `(namespace, schema_version)` not registered | HTTP 500 + log; consumer-module wiring issue |
| `PromoteValidationError`   | defensive re-validate failed                 | HTTP 422 (carries ZodError tree for caller)  |
| `PromoteConcurrencyError`  | both promote attempts hit 23505              | HTTP 409                                     |
| `RollbackAtGenesisError`   | latest version has no parent                 | HTTP 422                                     |
| `RollbackNoVersionError`   | no version exists for (tenant, namespace)    | HTTP 404                                     |
| `RollbackConcurrencyError` | both rollback attempts hit 23505             | HTTP 409                                     |

(`NamespaceSchemaNotRegisteredError` + `NamespaceSchemaConflictError` are sibling errors from `get-config.ts` + `schema-registry.ts`; same naming convention.)

**Test-helper precedent** (introduced Slice B): `packages/config-plane/test/_utils/cleanup.ts` exports `cleanupConfigPlaneState(pool, tenantId)` — FK-safe DELETE chain (`audit_event` → `config_draft` → `tenant_config_version`). Used by all Slice B specs. Future config-plane tests should reuse the helper rather than inline the chain.

**Cross-refs:**

- `docs/planning/p1.4-f04-configuration-plane-scope.md` (module scope; D1-D14 locks)
- `docs/planning/f04-slice-A-scope.md` (Slice A scope; sub-decision locks)
- `docs/planning/f04-slice-B-scope.md` (Slice B scope; Q-NEW-F04B-1/3/5/6/7/8/9 locks)
- `services/foundation/migrations/0014_f04_config_namespace_reshape.sql` (substrate reshape)
- `services/foundation/migrations/0015_f04_config_draft_table.sql` (config_draft table)
- `packages/canonical-schema/src/drizzle/schema.ts` (`tenantConfigVersion` + `configDraft` Drizzle definitions)
- `packages/config-plane/src/lifecycle.ts` (the 6 lifecycle helpers + 8 errors)

### Layered config resolution (Slice C)

`@cortex/config-plane` ships `resolveConfig<T>(client, tenantId, namespace) → Promise<T | null>` — the resolver walks tiers `tenant.<ns>` → `platform.<ns>` → registered in-code default; first match returns. Per-process LRU cache mediates (60s default TTL, per-consumer overridable). Lifecycle helpers (`promoteDraft`, `rollbackVersion`) actively invalidate the cache POST-commit.

**The 3-tier walk.** First non-null win:

```
resolveConfig(client, tenantId, 'theme')
  ├─ cache hit (key = tenantId :: 'theme')   → return cached value (may be null)
  ├─ getConfig(client, tenantId, 'tenant.theme')   → if non-null, cache + return
  ├─ getConfig(client, tenantId, 'platform.theme') → if non-null, cache + return
  └─ consumer.defaultValue (registered via registerConfigConsumer) → cache + return
```

`null` only when all three tiers are empty AND no consumer is registered (or consumer registered `defaultValue: null` deliberately).

**`platform.<ns>` is per-tenant, NOT cross-tenant** (D14). The `platform.*` literal namespace stores platform-shaped config as tenant-scoped rows — F04's substrate is per-tenant only; there is no cross-tenant slot. Genuine cross-tenant defaults live in-code via `registerConfigConsumer`'s `defaultValue` (the third tier). When F04 eventually ships workspace-namespace + cross-tenant substrate, in-code defaults can migrate to DB-driven without breaking consumers (the resolver's contract is tier-walk; the source of each tier is swappable).

**Dual-namespace schema registration.** `registerConfigConsumer({ namespace: 'theme', schema, schemaVersion, defaultValue })` is a thin wrapper over `registerNamespaceSchema` — registers the SAME schema under both `tenant.theme` AND `platform.theme`. Don't try to "deduplicate" by registering once: Slice B's namespace-keyed registry treats `tenant.<ns>` and `platform.<ns>` as distinct namespaces; both tiers need their own registration to validate. The consumer is the single point of truth; the registry double-records on the consumer's behalf.

**Cache key translation.** Cache is keyed on LOGICAL namespace (post-resolution; e.g., `'theme'`), but lifecycle operates on LITERAL namespace (the `tenant_config_version.namespace` column; e.g., `'tenant.theme'`). `invalidateResolverCacheForLiteralNamespace` strips the tier prefix (`tenant.` / `platform.` / `workspace.`) and invalidates the logical key. **Pessimistic invalidation**: ANY tier change invalidates the logical-key cache, even when a deeper tier wins (e.g., promoting `platform.theme` invalidates the `theme` cache entry even when `tenant.theme` exists and would dominate). Cost: occasional unnecessary re-reads. Benefit: correctness + simplicity (single cache entry per logical namespace; no per-tier slot management).

**Cache-resolved-null pattern.** `cacheGet` distinguishes miss (`undefined`) from hit-with-null (`{ value: null }`). The resolver caches `null` results to avoid repeated empty walks for namespaces with no registered consumer + no DB rows. Subtle implication: dynamic post-cache consumer registration (a `defaultValue` registered AFTER cache populated `null`) won't reflect until the entry's TTL expires or a lifecycle action invalidates it. Not a Phase 1 concern (registration is module-init), but flagged for future-proofing.

**Eviction is FIFO, not true LRU** — Map-insertion-order. True LRU would need access-time tracking. FIFO is adequate at 1000-entry / 60s TTL scale (~10 MB worst case at 10 KB/blob); when the cache fills, the oldest-inserted entries evict first. `cacheSet` deletes-and-re-sets on existing keys to bump their position (call it "insertion-order LRU bump"). Worth knowing if cache scaling ever becomes load-bearing — true LRU + access counters is a future enhancement, not a Phase 1 requirement.

**Post-commit invalidation placement.** Lifecycle invalidation fires AFTER the per-attempt transaction commits (`attemptPromote` / `attemptRollback` await `db.transaction(...)`, then call invalidate, then return). A failed transaction can't leave cache cleared without a corresponding audit row — failure throws inside the await, the invalidation line is never reached. Retry-twice path (UNIQUE-violation retry) invalidates only on the successful attempt's post-commit gate; the failed first attempt leaves cache untouched.

**Active invalidation vs TTL — single-replica vs multi-replica.** Phase 1 single-replica deploy gets exact consistency on the local replica via active invalidation + up-to-TTL consistency on remote replicas (none, in single-replica). Multi-replica deploy needs Redis-backed cache + Pub/Sub-broadcast invalidation — deferred to roadmap §1.12. Until §1.12 closes, multi-replica deploys see TTL-bounded staleness on non-mutating replicas (60s default; tunable per consumer).

**Cross-refs:**

- `docs/planning/f04-slice-C-scope.md` (Slice C scope; Q-NEW-F04C-1/2/3/4/5/6 locks)
- `packages/config-plane/src/resolve.ts` (the resolver)
- `packages/config-plane/src/cache.ts` (per-process LRU primitives)
- `packages/config-plane/src/consumer-registry.ts` (registerConfigConsumer)
- `packages/config-plane/src/lifecycle.ts` (`invalidateResolverCacheForLiteralNamespace` + the 2 post-commit call sites)
- `docs/future-roadmap.md` §1.12 (Redis migration; multi-replica path)

### Impact analysis (Slice D)

F04 Slice D ships breaking-change detection + promote-blocking for config changes. `analyzeImpact(db, tenantId, draftId)` runs against a draft pre-promote and surfaces a structured `ImpactReport` covering three orthogonal breaking-change axes:

- **`key_removed`** — a key any registered consumer cares about was removed from the config. Detected via structural JSON diff between `draft.draft_json` and the current latest version's `config_json`.
- **`schema_incompatible`** — a consumer pinned at schema v=N, but the data shape has shifted such that v=N's schema would reject it. Detected via Zod parse against the consumer's pinned schema version.
- **`policy_block`** — the consumer registered with `breakingChangePolicy: 'block'` and any keyPath of theirs was touched. Detected via consumer-keyPath × diff-path intersection.

**Override path:** callers pass `confirmBreakingChanges: true` to `promoteDraft`. Override emits a `CONFIG_VERSION_PROMOTED` audit row with enriched `after_state` metadata (`breaking_changes_overridden: true` + `affected_consumers` + `breaking_change_kinds`).

**Block path:** caller doesn't pass override; `promoteDraft` throws `ImpactBlockedError` carrying the report. `CONFIG_PROMOTE_BLOCKED` audit row emits in a SEPARATE transaction (the attempt's transaction rolled back when the throw fired; audit must survive the rollback).

### Audit-on-error in separate transaction

When auditing a REJECT-type event whose originating transaction rolled back, emit the audit in a fresh transaction. Pattern:

```ts
} catch (err) {
  if (err instanceof ImpactBlockedError) {
    // The attempt's transaction rolled back. Audit must
    // survive the rollback to record the rejection.
    await db.transaction(async (tx) => {
      await emitAuditEvent(tx, { ... });
    });
    throw err;
  }
}
```

DO NOT consolidate audit emission into the rolled-back transaction — the audit row would roll back too, defeating the purpose. This pattern applies to any REJECT-type event on a doomed transaction (current consumer: F04 Slice D's `CONFIG_PROMOTE_BLOCKED`; the load-bearing test in `impact-analysis.spec.ts` asserts the audit row exists post-rollback).

### Bidirectional path matching for impact analysis

Consumer keyPaths and diff paths match in either direction:

- Consumer registers `['theme','colors']`, diff hits `['theme','colors','primary']` → match (broader registered → narrower change).
- Consumer registers `['theme','colors','primary']`, diff hits `['theme','colors']` → match (narrower registered → broader change subsumes the specific path).

One-way matching would miss half the cases. The implementation is `pathMatchesKeyPath` in `impact-analysis.ts`; bidirectional is the contract, not an implementation detail.

### Dual catch-site behavior — two CONFIG_PROMOTE_BLOCKED rows per call on retry

`promoteDraft` can throw `ImpactBlockedError` on either the first attempt OR the retry-on-23505 second attempt (the retry path is for `PromoteConcurrencyError`, but `analyzeImpact` re-runs each attempt and may throw `ImpactBlockedError` independently). Each attempt's emission represents a real moment; auditing both is honest. Two `CONFIG_PROMOTE_BLOCKED` rows in a single user-call indicates a retry path; each row's `after_state` captures the impact at that attempt's moment (which may differ if a concurrent promote happened between attempts).

### Two-seam DB API design

- `getConfig` / `resolveConfig` retain the `Queryable` interface (narrow, single-read API) — caller passes `pg.PoolClient` or drizzle's via `withTenantContext`.
- `analyzeImpact` + lifecycle helpers use `NodePgDatabase` directly (lifecycle-shaped, transactional, multi-query API).

Two seams coexist by design. Don't speculatively unify — the surfaces have different requirements (read-narrow vs lifecycle-transactional).

### `registerConfigConsumer` vs `registerNamespaceSchema`

Two registration entry points by design:

- **`registerNamespaceSchema`** (Slice A primitive): minimal; for callers that don't need resolver/cache/impact (e.g., F03 Slice C's `tenant.scd`, where the trigger reads via raw SQL and the schema only validates draft data at promote-time).
- **`registerConfigConsumer`** (Slice C + extended Slice D): wraps `registerNamespaceSchema` + adds resolver/cache (`defaultValue`, `ttl`) + adds impact-analysis fields (`consumerModule`, `breakingChangePolicy`, `keyPaths`).

Impact analysis is OPT-IN: consumers omit `consumerModule` and they don't participate in impact reports. `registerNamespaceSchema` callers automatically don't participate. The `getImpactEligibleConsumers(namespace)` helper filters the registry to entries where `consumerModule !== undefined`.

**Cross-refs:**

- `docs/planning/f04-slice-D-scope.md` (Slice D scope; Q-NEW-F04D-1 through D-8 locks)
- `packages/config-plane/src/impact-analysis.ts` (`analyzeImpact`, `diffJson`, `pathMatchesKeyPath`)
- `packages/config-plane/src/schema-drift.ts` (`detectSchemaIncompatibilities`)
- `packages/config-plane/src/lifecycle.ts` (`emitImpactBlockedAudit` + `confirmBreakingChanges` wiring)
- `packages/config-plane/test/impact-analysis.spec.ts` (27 tests — block path's separate-transaction assertion is load-bearing)
- `docs/future-roadmap.md` §1.15 (audit_event silent-swallow workaround) and §1.16 (single-consumer-per-namespace constraint)

### Git sync stub (Slice E)

F04 Slice E ships the Configuration-as-Code Git-sync API surface as STUBS — Phase 2 deferred per build-prompt §F04 §4. `packages/config-plane/src/git-sync.ts` exports:

- `exportToYaml(ctx: GitSyncContext): Promise<string>` — Phase 2 will export every promoted `tenant_config_version` row for `ctx.tenantId` to a YAML representation suitable for committing to a per-tenant Git repository.
- `importFromYaml(ctx: GitSyncContext, yaml: string): Promise<void>` — Phase 2 will replay a YAML representation against `tenant_config_version` for `ctx.tenantId`, with each version becoming a draft → validate → promote round-trip per Slice B's lifecycle.
- `GitSyncNotImplementedError` — dedicated error class for type-narrowing in callers; `name === 'GitSyncNotImplementedError'` works in JSON-serialized contexts where `instanceof` is unreliable.
- `GitSyncContext` — the per-call context (currently `{ tenantId }`; Phase 2 widens to include Git remote URL + branch + auth material).

Both functions throw `GitSyncNotImplementedError` per Q-NEW-F04E-2 lock. Silent no-op would mask the deferral and create enterprise-customer surprise. Error messages reference roadmap §5.5 + build-prompt §F04 §4.

**Library choice deferred** per Q-NEW-F04E-3 — pinning `simple-git` / `isomorphic-git` / native `execSync` now commits to a future implementation choice prematurely; first Phase 2 consumer drives the choice.

**Async contract pinned**: stubs use `async` even though they only throw, so Phase 2 implementations can `await` consistently when the actual I/O lands. Suppressed `@typescript-eslint/require-await` lint with rationale comments.

### F04 module close

F04 module CLOSED 2026-05-10. Five slices shipped across 8 PRs over 2 days: A (storage substrate, PR #4), B (lifecycle, PR #5), C (resolver + cache, PR #8), D (impact analysis, PR #9), E (git-sync stub + module close, PR #10) — plus PR #6 closing F03 Slice C as a cross-feature pre-promote-safety inside P1.4. F04 is the **first F-module fully closed in the platform's lineage**.

Module-close commit shape per Q-NEW-F04E-5 lock: two-commit composition. Commit 1 `feat(F04-E): git-sync stub` lands the slice (source + tests + slice scope doc). Commit 2 `feat(F04): configuration plane` lands the symbolic module-close summary (gate evidence, status flip, roadmap backref, this CLAUDE.md subsection). Sets the precedent for all future module-close commits in the codebase — F02 didn't land its `feat(F02): tenant lifecycle manager` close commit yet, so F04 establishes the pattern.

**Gate evidence:** `docs/planning/f04-gate-evidence.md` captures build-prompt acceptance × evidence; D1-D14 module locks honored across all 5 slices; per-slice phase summary; cross-feature impact (F03 module status + downstream queue); PASS-by-construction note for the sub-10ms p99 acceptance criterion.

**Downstream queue unblocked:** P1.5 F05 Schema Evolution; P1.6 Feature Flags (`@cortex/feature-flags` is the named first consumer per D6); D04 quality rule library; UX01 theme tokens; IC01 vertical-package selection; IC02 i18n + locale; AC02 hierarchy schema; PR06 retention policies. Each becomes operator-selectable post-merge.

**F03 module-row remains unchecked.** F03 Slice C closed inside P1.4 (PR #6); F03 Slice D ("Late-arriving data") remains DEFERRED (blocked by D04 + S01 + SCR-08). F03's full module close lags F04's — readers shouldn't expect F03 ✓ to follow F04 ✓ in `status.md`.

## SCD policies (F03 Slice C)

`@cortex/temporal-query` ships the SCD-policy schema; `cortex.cortex_scd_trigger()` (migrations 0016/0017) reads policy from F04's `tenant_config_version` namespace `tenant.scd` and dispatches by per-entity-type config. Default-when-absent = SCD Type 2 (mandatory backward compat per Q-NEW-F03C-4).

### The 5 SCD types

| Type  | Semantic                                      | UPDATE behavior                                                                                 | DELETE behavior                                             |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **1** | Overwrite (no history)                        | In-place; row id stable                                                                         | Physical delete                                             |
| **2** | Row rotation (canonical bi-temporal default)  | Close OLD txn_time; INSERT NEW with rotated id                                                  | Logical close (row stays; txn_time upper set)               |
| **3** | Previous value in sibling column              | In-place; capture OLD's `<previousValueColumn>` to NEW's `<col>_previous` sibling               | Physical delete (Type 3 isn't history-preserving on delete) |
| **4** | Separate history table                        | Caller's UPDATE in-place; OLD INSERTed into history table                                       | Physical delete from main; OLD INSERTed into history        |
| **6** | Hybrid (Type 2 + per-column previous capture) | Type 2 row rotation PLUS per-column `<col>_previous` capture for cols in `previousValueColumns` | Type 2 logical close (no per-column capture on delete)      |

### `tenant.scd` namespace + hardcoded Type 2 fallback

Per Q-NEW-F03C-2 lock: SCD policies live in F04's `tenant.scd` namespace. **No `platform.scd`** — F04's substrate is per-tenant only (D14 ships `platform → tenant` resolution but both tiers are per-tenant rows; no cross-tenant slot exists for a platform-default row). The trigger's hardcoded Type 2 default IS the cross-tenant default.

**Forward-compat exit criterion:** if future F04 substrate work adds NULL-`tenant_id` support OR a separate `platform_config` table + RLS carve-out, the trigger's hardcoded Type 2 fallback can be replaced with a DB-driven default lookup. Slice C's trigger keeps the default-path isolated and replaceable for that future work.

### "Trigger trusts validated JSONB" anti-pattern

The trigger does NOT re-validate JSONB shape on every UPDATE/DELETE. Zod validation runs at promote-time via F04 lifecycle (`promoteDraft` defensively re-validates per Q-NEW-F04B-6). Once promoted, the JSONB in `tenant_config_version` is trusted — the trigger reads `entity_policy ->> 'type'` directly without re-checking shape.

**Anti-pattern:** bypassing F04 lifecycle to mutate `tenant_config_version` directly via raw SQL. The trigger will read whatever's there and may dispatch to a malformed code path. **Always go through `createDraft → validateDraft → promoteDraft` for SCD policy changes.**

### `EXCEPTION WHEN insufficient_privilege` catch (test-fixture tolerance)

The trigger's policy lookup queries `tenant_config_version` which is RLS-bound (`FOR ALL tenant_id = current_tenant_id()`). Callers without `app.tenant_id` bound (e.g., test fixtures running raw INSERT/UPDATE/DELETE without `withTenantContext`) would otherwise hit SQLSTATE 42501 from `cortex.current_tenant_id()`. The trigger wraps the policy lookup in `BEGIN/EXCEPTION WHEN insufficient_privilege` → `policy_json := NULL` → Type 2 default fallback.

**Production callers ALREADY bind tenant context** via `bindTenantToDbSession()` before any UPDATE/DELETE on bi-temporal tables (RLS would fail-closed otherwise). The exception path is a test-fixture accommodation, NOT a production code path. Future maintainers reading the trigger should see WHY this catch exists, not have to reconstruct reasoning.

### Schema-version mutation rule

Per Q-NEW-F03C-7e: schema versions registered via `registerNamespaceSchema(namespace, schema, { version })` **can be mutated in-place when no production drafts pin to them**. Bump the version only when (a) active drafts exist that would invalidate against the new shape, OR (b) the change would invalidate registered consumers. Slice C C.3's tightening of Types 3/4/6 from placeholder to locked shapes was an in-place v=1 mutation — safe because zero production drafts currently pin to v=1.

This rule applies workspace-wide; F04's `registerNamespaceSchema` precedent (`@cortex/config-plane/src/schema-registry.ts`) governs the registry, but the mutation policy is owned at the slice-author level.

### Caller responsibilities (per-Type DDL)

The trigger raises clean errors when caller-managed DDL is missing:

- **Type 3** requires sibling `<previousValueColumn>_previous` column on the table. Trigger raises if missing.
- **Type 4** requires the history table (`<historyTableName>` or default `<TG_TABLE_NAME>_history`) to exist. Trigger raises if missing.
- **Type 6** requires sibling `<col>_previous` column for EACH entry in `previousValueColumns`. Trigger raises if any sibling missing.

Caller-managed = consumer's migration creates the sibling columns / history table BEFORE promoting the policy. Future enhancement (out of Slice C scope; tracked in slice scope doc): F04 `validateDraft` hook to check `information_schema.tables` + `information_schema.columns` at promote-time.

### Future-notes

- **Type 7 (multi-column previous-value-only)** — canonical SCD has 5 types (1, 2, 3, 4, 6); Type 5 is a deprecated label. A hypothetical Type 7 = multi-column previous-value capture WITHOUT row rotation (Type 3 across multiple columns). Ship if a first consumer needs multi-column previous-value tracking without row history (currently Type 6 covers this case but couples to row rotation). First-consumer-driven per ADR-DB-001 deferral pattern.
- **F04 `validateDraft` Type 4 history-table existence check** — cross-module enhancement; would let promote fail-fast at lifecycle-time instead of trigger raising at first UPDATE. Implementation: F03 Slice C registers a validate-hook with `@cortex/config-plane`; hook is called from `validateDraft` for `tenant.scd` namespace drafts.
- **Cross-tenant DB-driven default** — F04 substrate work to support NULL `tenant_id` + RLS carve-out, OR a separate `platform_config` table. Would replace the trigger's hardcoded Type 2 fallback with a DB-driven default. Tracked in slice scope doc as forward-compat exit criterion.

**Cross-refs:**

- `docs/planning/f03-slice-C-scope.md` (Slice C scope; Q-NEW-F03C-1-7 locks)
- `docs/planning/f03-temporal-data-engine-scope.md` (F03 module scope; multi-phase close timeline)
- `services/foundation/migrations/0016_f03_scd_policy_aware_trigger.sql` (trigger rewrite — Types 1/2 + stubs)
- `services/foundation/migrations/0017_f03_scd_types_3_4_6.sql` (full Types 3/4/6 implementations)
- `packages/temporal-query/src/scd-policy.ts` (Zod schema + namespace registration)
- `services/foundation/test/scd-policy-trigger.spec.ts` (16 per-type behavior tests + F04 lifecycle integration)

## Feature flags

- All new capabilities roll out behind a feature flag (`@cortex/feature-flags`)
- Flags tracked in F04; retire within 6 months of stability

## Service account naming

- Runtime SAs (per workload): `<service-short-name>-runtime` (e.g., `api-gateway-runtime`, `planogram-runtime`)
- Cross-project admin SAs: `cortex-<purpose>-admin` or `cortex-<purpose>` (e.g., `cortex-tf-admin`, `cortex-observer`)
- Invoker SAs: `<caller>-invoker` (e.g., `scheduler-invoker`)
- One SA per workload. Services never share SAs.
- No module IDs in runtime SA names — use `planogram-runtime`, not `a01-planogram-runtime`.
- See `/docs/architecture/decisions/ADR-INFRA-002-terraform-bootstrap.md` for the SA identity model.

## Secret Manager naming

- Pattern: `cortex-<category>-<specific-name>`
- Categories: `auth`, `ai`, `email`, `db`, `webhook`, `integration`, `tenant-<tenant-id>`, `app`
- Strict environment separation — every secret exists independently in each env project (`sevyn8-cortex-{dev,staging,prod}`). No shared secrets across envs.
- CMEK-encrypted via `cortex-secrets-key` in each env's `cortex-keyring`.
- Reference `:latest` by default. Pin a specific version only when rotation cadence is deliberately de-coupled from consumer restarts.
- `cortex-observer` has zero `secretmanager.*` effective permissions by role design (`roles/viewer` excludes Secret Manager). P0.5 adds a CI-check validating this.
- See `/infra/terraform/modules/secret/` for the creation helper and its naming-regex validation.

## Terraform conventions

- Format with `terraform fmt -recursive` before commit.
- 2-space indent. Align equals within a block where it improves readability.
- Resource names: snake*case (`google_compute_network.cortex_vpc`). Resource-name \_values* follow GCP naming (hyphens).
- File layout per root/module: `providers.tf`, `versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`, `locals.tf` (when 3+ locals).
- Version pins: Terraform `~> 1.14.0`; `hashicorp/google ~> 6.0`, `hashicorp/google-beta ~> 6.0`, `hashicorp/random ~> 3.6`.
- Every `variable` has `type` and `description`. `default` only when truly defaultable.
- Every `output` has a `description`.
- Module source paths use local relative paths (`../../modules/...`), not registry URLs.
- Use `moved { ... }` blocks for resource renames — avoids destroy + recreate.
- Prefer explicit resource declarations when item count is small and stable (e.g., 4 firewall rules as 4 blocks).
- Use `for_each` for dynamic-count collections (API enablement, cartesian IAM bindings).
- Use `data` sources for existing-resource attribute lookups (project numbers, service-agent emails). Avoid `terraform import` unless deliberately adopting a resource into Terraform management.
- Prefer `google_*_iam_member` (additive). Never use `google_*_iam_policy` or `google_*_iam_binding` (authoritative — overwrites existing bindings).
- IAM member prefixes: `serviceAccount:`, `group:`, `user:`, `principal://` (deny-policy v2).
- `lifecycle { prevent_destroy = true }` on KMS keys and state buckets.
- No downloaded JSON keys. SA impersonation only.
- Resource labels: `managed_by = "terraform"`, `project = "cortex"`, `environment = "<env>"`, `prompt = "<creation-prompt-id>"`.
- Each root module's state owns its own resources. No cross-state ownership.
- See ADR-INFRA-002, -003, -004 in `/docs/architecture/decisions/`.

## Terraform workflow

- Plan before apply, always. Never apply without reviewing the diff.
- `terraform apply <planfile>` is the apply shape used after review. `terraform apply -auto-approve` without a saved plan file is forbidden.
- Never create infrastructure via GCP Console. If it isn't in Terraform, it doesn't exist.
- Use the Makefile `tf-*` targets for all env operations. They bake in `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` and the prod gate.
- Prod applies require `CONFIRM=yes`: `make CONFIRM=yes tf-apply-prod`.
- After any apply, re-run `tf-plan-<env>` to verify idempotency. A non-empty re-plan is drift — investigate before anything else.
- Commit Terraform code changes that drove an apply alongside related app-level changes where possible, so the "what happened" is one `git log` entry.
- See `/docs/runbooks/infrastructure.md` for day-to-day operations.

## IAM gotchas

- **"Request had invalid authentication credentials" on first apply of `google_service_networking_connection`** — PSA service-agent propagation race in newly-enabled projects; retry after 30–60s. See ADR-INFRA-002 Quirk 2.
- **"Role roles/iam.denyAdmin is not supported for this resource"** — only grantable at org/folder level, not project. Phase 1 defers env-level deny policies; rely on implicit deny via role design. See ADR-INFRA-002 Quirk 4.
- **`iam.googleapis.com/denypolicies.create` (or other IAM v2 permission) denied despite SA holding `roles/owner`** — IAM v2 permissions are carved out of legacy `roles/owner`. Grant the v2-specific admin role explicitly. See ADR-INFRA-002 Quirk 3.
- **CMEK-requiring resource creation fails with "permission denied" on the key** — the service's service agent needs `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the specific CMEK key. Compute email deterministically from project number; grant lives in the consuming env module, not bootstrap. See ADR-INFRA-002 Quirk 5.
- **`google_project_service_identity` returns `.email = null`** — provider quirk when the service agent was materialized pre-Terraform. Use `data "google_storage_project_service_account"` (or equivalent service-specific data source) instead. See ADR-INFRA-002 Quirk 1.
- **"Service account service-\<N\>@gcp-sa-cloud-sql.iam.gserviceaccount.com does not exist" on first Cloud SQL CMEK grant** — Cloud SQL service agent is materialized lazily on first use, not at API-enable time; and IAM propagation of the agent's existence lags its creation by ~30-60s. Add `google_project_service_identity` (google-beta) + a `time_sleep` of 60s before any IAM grant targeting the agent in a fresh project. See ADR-INFRA-005 Quirk 1.

## Image tagging

- Floating tags: EXACTLY `dev`, `staging`, `prod`. No variants — no `dev-experimental`, no `prod-backup-v2`, no tag starting with these words. The Artifact Registry cleanup policy uses prefix match; variants would be retained forever.
- Semver tags: `v<major>.<minor>.<patch>` (e.g., `v1.2.3`). Kept indefinitely.
- SHA tags: `sha-<git-commit-sha>` (e.g., `sha-a1b2c3d`). Immutable — `immutable_tags = true` on every repo prevents overwrites.
- Untagged images deleted after 90 days.
- Cloud Run services reference SHA tags (immutable, deterministic deploys). Floating tags are for human convenience and CI promotion workflows only.
- See `/infra/terraform/modules/artifact-registry/` for the cleanup policies as code.

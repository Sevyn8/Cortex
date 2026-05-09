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

## Branching & PR

- Trunk-based. Main is always deployable
- Short-lived branches: `{prompt-id}-{short-desc}` (e.g., `p1.1-f01-multi-tenancy`)
- PR required to merge to main. At least one human review for non-trivial PRs
- Solo dev OK to self-review, but use M4 Code Review meta-prompt between sessions

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

### Testing RLS-protected tables

- Vitest runs as `postgres` (superuser). By default, table owners bypass RLS — policy tests would silently pass without enforcing anything.
- Set `ALTER TABLE <t> FORCE ROW LEVEL SECURITY` in `beforeAll`, pair with `NO FORCE` in `afterAll`. Real Phase 1 tables do NOT need FORCE in production (F01 middleware never runs as superuser).
- Use `withTenantContext(pool, tenantId, fn)` / `withoutTenantContext(pool, fn)` from `@cortex/canonical-schema/rls-test` to set / unset tenant context inside a test transaction. The helpers use `set_config` under the hood for the reason in the "Session variables" section above.

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

# Cortex Build Progress

Last updated: 2026-04-25 (F01 Slice A complete; remaining Phase 0: P0.6 Phase 2 library + P0.10; F01 Slices B/C next)

## Pre-flight

- [x] Claude Code installed + logged in
- [x] GitHub org + repo set up (Sevyn8/Cortex)
- [x] Repo cloned into WSL (~/projects/Cortex)
- [x] v2.1 spec committed at docs/spec/cortex_v2.docx (superseded 2026-04-21)
- [x] v2.2 spec committed at docs/spec/cortex_v2.2.docx (2026-04-21 — adds Part VII-b "The Case for MCP"; no v2.1 content modified)
- [x] v3 build prompts committed at docs/build-prompts/cortex_build_prompts_v3.md
- [x] ADR-INFRA-001 + ADR-SCOPE-009 committed
- [x] Sevyn8 workflow SKILL.md committed
- [x] Integration stubs committed (roos-interface.md, roos-agent-boundaries.md)
- [x] GCP org + billing + projects set up
- [x] WorkOS account created
- [x] Anthropic API key procured
- [x] Resend account created
- [ ] Ithina contacts confirmed (HHT, POS, training data)
- [ ] Architectural decisions reviewed (Appendix D of build prompts)
- [ ] DPA between Sevyn8 and Display Data drafted

## Phase 0 — Foundation

- [x] P0.1 Initialize monorepo
- [x] P0.2 Dev environment
- [x] P0.3 GCP Terraform baseline
- [x] P0.4 Postgres + bi-temporal helpers
- [x] P0.5 CI/CD
- [ ] P0.6 Observability baseline — Phase 1 DONE 2026-04-24; Phase 2 + 3 below
  - [x] Phase 1 operator infrastructure + Phase 8 synthetic validation (2026-04-24)
  - [ ] Phase 2 `@cortex/observability` library — hard gate ONLY for P0.10 (can land before or after P0.9; see ADR-SEQ-001 amendment)
  - [ ] Phase 3 dashboards — DEFERRED indefinitely (no hard consumer; trigger on operator ask)
- [x] P0.7 Secret Manager + KMS (2026-04-24)
- [x] P0.9 Super Admin bootstrap (2026-04-24)
- [ ] P0.10 Audit event emission convention

## Phase 1 — Display Data Go-Live

### Foundation Layer

- [ ] P1.1 F01 Multi-Tenancy ← IN PROGRESS
  - [x] Slice A — Tenant context + DB isolation (2026-04-25, commit `<F01_SLICE_A_HASH>`)
  - [ ] Slice B — Encryption + GCS isolation
  - [ ] Slice C — Quotas + Compute isolation
- [ ] P1.2 F02 Tenant Lifecycle
- [ ] P1.3 F03 Temporal Data Engine
- [ ] P1.4 F04 Configuration Plane
- [ ] P1.5 F05 Schema Evolution
- [ ] P1.6 Feature Flags

### MCP interlude (per ADR-SEQ-001)

- [ ] P0.8 MCP scaffolding + protocol-agnostic tool platform — moved from Phase 0; lands after F05 with real tools to register

### Access Control

- [ ] P2.1 AC01 ABAC + RBAC
- [ ] P2.2 AC02 Hierarchy
- [ ] P2.3 AC03 Consent
- [ ] P2.4 AC04 Compliance Policy

### Data Platform

- [ ] P3.1 D01 Canonical Model
- [ ] P3.2 D02 Mapping Engine
- [ ] P3.3 D03 Data Contracts
- [ ] P3.4 D04 Data Quality
- [ ] P3.5 D05 Lineage
- [ ] P3.6 D06 Polyglot Storage

### Identity & Ingestion

- [ ] P4.1 I01 SIR
- [ ] P4.2 I02 Knowledge Graph
- [ ] ~~P4.3 I03 Conflict Resolution~~ (deferred to Phase 2)
- [ ] P4.4 G01 Ingestion Gateway (per ADR-INFRA-001 + ADR-SCOPE-009)
- [ ] P4.5 G02 Structured Pipeline

### Cross-Cutting Platform

- [ ] P5.1 S01 Streaming
- [ ] P5.2 IC01 Industry Ontology
- [ ] P5.3 IC02 Localization
- [ ] P5.4 A05 LLM Gateway
- [ ] P5.5 A06 Rule Engine
- [ ] P5.6 O01 API Gateway
- [ ] P5.7 O02 Alert Engine
- [ ] P5.8 O04 Action Hub
- [ ] P5.9 OB01 Observability
- [ ] P5.10 OB02 FinOps (stub)
- [ ] P5.11 OB03 Metering (stub)
- [ ] P5.12 PR01 Purpose Registry
- [ ] P5.13 PR03 Breach Detection
- [ ] P5.14 PR05 Sub-Processor Registry
- [ ] P5.15 PR06 Retention Clock
- [ ] P5.16 RE01 Disaster Recovery
- [ ] P5.17 Retail Vertical Package
- [ ] P5.18 Display Data Extension Package
- [ ] P5.19 Standard Error Format
- [ ] P5.20 Email Templates

### Frontend Foundation

- [ ] P6.1 Next.js apps + shell
- [ ] P6.2 Design system + Storybook
- [ ] P6.3 Screen Registry consumer
- [ ] P6.4 Layout Engine
- [ ] P6.5 Widget library scaffolding

### Widget Library

- [ ] P7.1 KPI cards
- [ ] P7.2 Charts
- [ ] P7.3 Data table
- [ ] P7.4 Filters
- [ ] P7.5 Entity cards
- [ ] P7.6 Alerts feed
- [ ] P7.7 Conversational
- [ ] P7.8 Proposal Inbox (+ design spike)
- [ ] P7.9 Leaderboard

### Admin Console

- [ ] P8.1 SCR-01 Tenant Overview
- [ ] P8.2 SCR-02 Users
- [ ] P8.3 SCR-04 Tenant Config
- [ ] P8.4 SCR-05 Hierarchy
- [ ] P8.5 SCR-06 Role & Permission
- [ ] P8.6 SCR-07 Schema Browser
- [ ] P8.7 SCR-08 Data Source Wizard
- [ ] P8.8 SCR-09 Mapping Studio
- [ ] P8.9 SCR-10 Data Quality
- [ ] P8.10 SCR-16 Consent Manager
- [ ] P8.11 SCR-19 Alert Rules
- [ ] P8.12 SCR-20 Audit Log
- [ ] P8.13 SCR-24 Platform Ops (min)
- [ ] P8.14 W01 Onboarding Wizard

### Analytical Screens

- [ ] P9.1 CX-01 Executive Dashboard
- [ ] P9.2 CX-02 Store Performance
- [ ] P9.3 CX-04 Alert Centre
- [ ] P9.4 CX-DD-01 Shelf & Planogram Intelligence

### Ithina Agents

- [ ] P10.1 Agent runtime
- [ ] P10.1a Model Registry Light
- [ ] P10.2 Planogram Agent
- [ ] P10.3 PAC Agent
- [ ] P10.4 Promotion Agent
- [ ] P10.5 Perishable Agent
- [ ] P10.6 Testing harness
- [ ] P10.7 CSV Ingestion Agent

### Display Data Go-Live

- [ ] P11.1 Staging tenant provisioned
- [ ] P11.2 Shelf imagery ingestion live
- [ ] P11.3 POS ingestion live via ROOS
- [ ] P11.4 E2E validation GREEN
- [ ] P11.5 Backup restoration drill

## Testing & Production

- [ ] P15.1 Unit coverage baseline
- [ ] P15.2 T01 Testing Framework
- [ ] P15.3 E2E automation
- [ ] P15.4 Frontend quality gates
- [ ] P15.5 Load testing
- [ ] P15.6 Staging deploy runbook
- [ ] P15.7 Production deploy runbook
- [ ] P15.8 Incident response runbook

## Release criteria for Display Data production

- [ ] All Phase 1 prompts checked
- [ ] P11.4 E2E validation GREEN
- [ ] P11.5 Backup drill GREEN (RTO <2h, RPO <1h)
- [ ] Penetration test complete
- [ ] DPA signed
- [ ] Sub-processor list published
- [ ] DPO compliance sign-off
- [ ] First-48-hour monitoring plan staffed
- [ ] ROOS interface contract fully filled in

## Completion notes

Per-prompt completion records for prompts that landed substantive work. Short summaries; detail lives in ADRs and commits.

### P0.3 — GCP Terraform baseline (2026-04-21)

- **Resources landed:** 168 Terraform-managed GCP resources — bootstrap 77, dev 25, shared 16, staging 25, prod 25, tfstate stub 0.
- **Deliverables:** 3 ADRs (INFRA-002, -003, -004); Terraform bootstrap module + 5 shared modules (project-baseline, networking, kms, secret, artifact-registry) + 5 env roots (dev, staging, prod, shared, tfstate); 20 Makefile `tf-*` targets; infrastructure runbook; top-level `/infra/terraform/` orientation README; 6 new CLAUDE.md convention sections.
- **Five quirks cataloged** for future reference (see ADR-INFRA-002 Implementation notes):
  - `google_project_service_identity` returns null `.email` when agent pre-exists → use data source
  - `google_service_networking_connection` first-apply race → retry is baseline
  - `roles/owner` excludes IAM v2 permissions → grant v2-specific admin roles explicitly
  - `roles/iam.denyAdmin` only grantable at org/folder → project-level bind fails
  - Per-service CMEK service-agent grants live in consuming env modules (not bootstrap); email deterministic from project number
- **Deferred items with follow-up prompts:**
  - P0.5: CI-check for cortex-observer permission drift (compensating control for deny-policy deferral)
  - P0.5/0.6: default VPC deletion across 5 projects (needs cleanup module pattern)
  - P11.4: HSM key upgrade for prod (4-phase migration plan in ADR-INFRA-004 Implementation note 5)
  - Phase 2+: org-level `roles/iam.denyAdmin` coordination to re-introduce env-level deny policies
  - Phase 2+: per-tenant CMEK (D01 tenant_id-to-key binding)

### P0.4 Phase A — Cloud SQL provisioning (2026-04-21)

- **Session duration:** ~13 hours from P0.4 kickoff to Phase A push (inclusive of the pre-P0.4 spec-version cleanup and two intermediate architectural decision rounds).
- **Resources landed:** 15 new Terraform-managed resources — cloud-sql module instantiated per env (dev, staging, prod), each creating a Postgres 17 Enterprise instance + default `cortex` database + CMEK grant + service-agent materialization trigger + IAM-propagation wait.
- **Deliverables:** 1 new ADR (INFRA-005); `cloud-sql` Terraform module (5 files); env additions across dev/staging/prod (9 file changes including `.terraform.lock.hcl` for the new `google-beta` and `hashicorp/time` providers); amended ADR-INFRA-002 Quirk 1 + Quirk 5 patterns; amended CLAUDE.md IAM gotchas (+1 bullet).
- **Instance inventory:**

  | Env     | Instance                | Private IP  | Tier              | HA       | Backups | PITR | max_conn |
  | ------- | ----------------------- | ----------- | ----------------- | -------- | ------- | ---- | -------- |
  | dev     | cortex-dev-postgres     | 10.10.240.3 | db-custom-2-8192  | ZONAL    | 7       | 1    | 100      |
  | staging | cortex-staging-postgres | 10.20.240.3 | db-custom-2-8192  | ZONAL    | 7       | 3    | 100      |
  | prod    | cortex-prod-postgres    | 10.30.240.2 | db-custom-4-16384 | REGIONAL | 14      | 7    | 200      |

  All three Enterprise edition, POSTGRES_17 (maintenance `POSTGRES_17_9.R20260319.00_02`), CMEK-encrypted via each env's `cortex-cloudsql-key`, private IP only, IAM auth enabled, query insights on, `settings.deletion_protection_enabled = true`, maintenance window Sunday 22:00 UTC stable track.

- **Two new quirks** documented in ADR-INFRA-005 Implementation Notes:
  - Quirk 1 — Cloud SQL service-agent materialization + IAM propagation race (first-apply failure on fresh projects). Resolved via `google_project_service_identity` (google-beta) + `time_sleep(60s)` before the CMEK grant.
  - Quirk 2 — Transient GCS-backend state write failure during prod apply (WSL2 DNS flake). Recovered via `terraform state push errored.tfstate`.
- **Two observations** also documented: `deletion_protection` has two distinct fields (Terraform-side top-level + GCP-side `settings.deletion_protection_enabled`; module now sets both); Cloud SQL Postgres 17 Enterprise defaults to `CLOUD_STORAGE` for transaction logs (older docs said `DISK` for Enterprise).
- **Phase B scope (pending, estimated 4–6 hours):**
  - 4 migrations in `/services/foundation/migrations/`: bi-temporal helpers (tstzrange wrappers + SCD triggers + temporal query library), RLS baseline (`current_tenant_id()` + policy templates), audit event table with SHA chain (per Cortex v2.2 §SCR-20-FR-009), `pgvector 0.8.1` extension enablement.
  - `@cortex/canonical-schema` package skeleton — TS types for `tstzrange`, bi-temporal envelope.
  - 5 ADRs to create: ADR-STACK-003 (Drizzle ORM), ADR-STACK-005 (drizzle-kit migration tool), ADR-DB-001 (bi-temporal implementation), ADR-DB-002 (RLS session-variable contract), ADR-DB-003 (audit event SHA chain).

### P0.4 Phase B — Bi-temporal helpers, RLS, audit chain (2026-04-22)

- **Session duration:** ~1 day (scaffolding → 4 migrations → docs), with a mid-session detour to resolve laptop-to-Cloud-SQL connectivity.
- **Resources landed:**
  - 4 DB migrations applied to **dev only** (0001 extensions / cortex schema, 0002 bi-temporal helpers, 0003 RLS baseline, 0004 audit chain). Staging and prod deferred to P0.5 CI runner.
  - 1 Terraform change: dev `cloud-sql` module now has `public_ip_enabled = true` + narrow `authorized_networks` allowlist (laptop IP only). In-place update, no instance recreate. Staging / prod unchanged.
- **Deliverables:**
  - 3 new ADRs: ADR-DB-001 (bi-temporal implementation), ADR-DB-002 (RLS session-variable contract), ADR-DB-003 (audit event SHA chain).
  - ADR-INFRA-005 amended: "Dev exception to Decision 11" + 2 new observations (Cloud SQL Auth Proxy ADC separation; `--private-ip` flag requirement).
  - `@cortex/canonical-schema` package (TstzRange / BiTemporalRow types, tstzrange Drizzle custom type, `withTenantContext` / `withoutTenantContext` RLS helpers, `createDrizzleClient` factory).
  - `services/foundation` service (vitest harness, test helpers with proxy liveness check, 3 acceptance test suites — 22/22 green).
  - `drizzle.config.ts` at repo root; Makefile targets `db-proxy-{dev,staging,prod}` + `db-migrate-{dev,staging,prod}`; `pnpm-workspace.yaml` catalog for drizzle-orm / drizzle-kit / pg / zod / vitest.
  - New CLAUDE.md sections: "Workspace layout" + "Database conventions" (5 subsections).
- **DB artifacts created in dev:**
  - `cortex` schema hosting 3 functions — `current_tenant_id()`, `at_time_t()`, `cortex_scd_trigger()` — and the audit helpers `audit_canonical_hash()`, `audit_chain_trigger()`.
  - `audit_event` table: 12 columns, PK + tenant_time index, RLS enabled, 2 policies (tenant_read / tenant_write), append-only trigger.
  - 3 extensions installed: `pgcrypto`, `vector` (0.8.1), `btree_gist`.
- **Six new observations** documented across ADRs (all cross-referenced from CLAUDE.md "Database conventions"):
  - **ADR-INFRA-005:** Cloud SQL Auth Proxy ADC separate from `gcloud` CLI auth (RAPT expiration race); `--private-ip` flag required on private-only instances.
  - **ADR-DB-001:** Drizzle journal timestamps act as a high-water mark (placeholder files silently block future fills).
  - **ADR-DB-002:** `SET LOCAL` does not accept bind parameters — use `set_config()`.
  - **ADR-DB-003:** `timestamptz` round-trips lose microsecond precision via JS Date (hash computations must be server-side); TRUNCATE bypasses ROW triggers (production role cannot hold TRUNCATE on audit_event).
- **Scope reductions during execution:** (a) ADR-STACK-003/005 dropped — Drizzle conventions captured in CLAUDE.md instead; (b) staging/prod migration applies deferred — laptop cannot reach private-IP Cloud SQL, dev public-IP exception accepted until P0.5 Cloud Build runner lands.
- **Deferred items with follow-up prompts:**
  - P0.5: VPC-internal migration runner (Cloud Build) to replay 0001–0004 to staging + prod; removes the dev public-IP exception trigger.
  - P0.5: CI pipeline wires `pnpm --filter @cortex/foundation test` into PR checks.
  - First-consumer deferrals from ADR-DB-001/002/003: per-table `as_of_valid` wrappers, `verify_chain`, advisory locks / chain-tail / partial unique index (forks), `cortex_admin` role / admin-bypass policies.
  - SCR-20 (audit log UI) when it lands → implement `verify_chain` and admin-bypass.

### P0.5 CI/CD — Completion notes (2026-04-23)

**Shipped:**

- WIF substrate across 5 GCP projects (shared + dev/staging/prod + tfstate) — identity pool, provider, per-env submit and worker service accounts with scoped bindings
- Cloud Build migration runners in private pools inside each env's VPC — private-IP Cloud SQL access, no public surface
- Rich 6-section verify output (tables, schemas, functions, extensions, audit count, migration state)
- GitHub Actions workflows: migrate-dev, migrate-staging, migrate-prod (manual dispatch, WIF-authenticated), ci.yaml (ephemeral Postgres + 22 Phase B tests on PR and push)
- Branch protection on main requiring ci.yaml status check
- Dev Cloud SQL public-IP exception reverted per ADR-INFRA-005 reversion trigger

**Architectural discoveries captured as ADR amendments:**

- ADR-INFRA-006 Decision 4 amended: worker SA needs `logging.logWriter` + `storage.objectViewer` for private-pool logging + source access
- ADR-INFRA-006 Decision 4 amended: submit SA needs `cloudbuild.builds.builder` (not `builds.editor`) — covers source bucket access and serviceusage
- ADR-CI-001 Implementation notes amended: submit SA permissions discovery via first GitHub Actions dispatch (run 24833217219)
- CLAUDE.md new section: Turbo env var passthrough convention (strict env mode strips undeclared vars)
- ADR-CI-001 Implementation notes amended: CI test role model — stock Postgres bootstrap superuser can't drop SUPERUSER, non-superuser role required for RLS enforcement in tests; audit_event ownership transfer required for FORCE RLS

**Unplanned side-quest:**

- Repo transferred mid-phase from `rahul-1974/Cortex` to `Sevyn8/Cortex` (GitHub org). Required updates to WIF provider attribute_condition + 3 env submit SA bindings (case-sensitive match) + local git remote + 5 doc files. All applied, end-to-end validated via migrate-dev dispatch #3/#4.

**Repo state at P0.5 close:**

- Main HEAD: accb73c (dev public-IP revert)
- All 3 envs: private-IP Cloud SQL, Cloud Build migration runners operational, migrate-\*.yaml workflows dispatch-validated
- ci.yaml: passing, 22/22 foundation tests green
- Branch protection: active on Sevyn8/Cortex main, classic API, admin bypass preserved for solo dev

**Deferred (explicitly):**

- `cortex-ci-test-shared` SA in shared project — ADR-INFRA-006 Decision 4 marks this deferred until first GCP-accessing CI workflow (trigger: pre-baked builder image per ADR-CI-001 Option B)
- Default VPC cleanup (ADR-INFRA-003 follow-up) — housekeeping, separate commit when convenient

**Total shipped:** 12+ commits, 10+ ADRs touched, 2 new ADRs drafted

### P0.6 Phase 1 + Phase 8 — Observability operator infrastructure (2026-04-24)

**Shipped:**

- `modules/monitoring/` (5 files, ci-runner idiom): per-env notification channels (3 email + 1 Chat webhook), 2 log-based metrics (wif_auth_failures, cloud_build_submit_failures), 7 alert policies. Commit 703878f.
- `project-baseline` audit_config for iam.googleapis.com + sts.googleapis.com — required for WIF token-exchange events to reach logs.
- Env wiring across dev/staging/prod; 47 GCP resources applied across 4 envs total.

**Phase 8 validation:**

- Chat webhook: direct-post HTTP 200 at 2026-04-24 — delivery proven end-to-end.
- WIF filter: initial filter watched sts.googleapis.com; synthetic dispatch revealed GHA auth failures actually log to iamcredentials.googleapis.com. Filter fixed + ADR observation captured. Counter incremented post-fix. Commit 0f21845.
- Cloud Build submit failure: filter structurally correct; retrigger blocked by gcloud pre-flight validation. Filter trusted on structural match.

**Architectural discoveries captured as ADR-OBS-001 Implementation notes:**

- `notification_rate_limit` only valid on `condition_matched_log` policies, not on `condition_threshold` against log-based user metrics.
- GHA WIF auth failures log to `iamcredentials.googleapis.com:GenerateAccessToken`, not STS. Two-step OIDC flow (STS exchange silent; iamcredentials impersonation where binding is checked).
- `iamcredentials.googleapis.com` does NOT support service-level `google_project_iam_audit_config` (GCP 400); events log as Admin Activity by default.

**Sequencing change (per ADR-SEQ-001):**

- P0.6 Phase 2 `@cortex/observability` library slots between P0.7 and P0.9 (was: before P0.8).
- P0.6 Phase 3 dashboards deferred indefinitely.
- P0.8 MCP moved out of Phase 0 to post-F05.

**Deferred (explicitly):**

- Email channel verification (9 channels NOT_SET across dev/staging/prod). Tracked in docs/deviations.md. CRITICAL alerts still deliverable via Chat.
- bi-temporal test flake (services/foundation/test/bi-temporal.spec.ts:153) — instrumentation in commit 2604c85; waiting for natural CI flake recurrence to capture diagnostic data.
- Default VPC cleanup (ADR-INFRA-003 follow-up) — rolled into general housekeeping.

**Commit trail:** 703878f (Phase 1 infra) · 2604c85 (bi-temporal diagnostic instrumentation) · 0f21845 (WIF filter fix) · this commit (sequencing re-shape).

### P0.7 — @cortex/secrets package (2026-04-24)

**Shipped:**

- New package `packages/secrets/` (7 src files + 5 unit test files + 2 integration test files + README + 3 configs). Commit 8f55b8a.
- Public API: `secrets.get/put`, `envelope.encrypt/decrypt`, `getKeyForTenant` (Phase 1 stub per ADR-INFRA-004 Decision 5).
- Wire format: `[ver=1][wrap_len u16 BE][wrapped_DEK][IV 12][tag 16][ciphertext]`. AES-256-GCM, per-op random 32-byte DEK, `utf8(tenantId)` as AAD (programmatic cross-tenant protection).
- Envelope wraps with `cortex-general-key`; `cortex-secrets-key` stays exclusive to Secret Manager's own CMEK.
- Input validation via zod; secret-id regex byte-identical to `infra/terraform/modules/secret/variables.tf`.
- Audit logging: `[SECRETS-AUDIT]` JSON lines to stderr with TODO marker for `@cortex/observability` swap at P0.6 Phase 2.

**Tests:**

- 65 unit tests pass (errors, config, per-tenant-keys, secret-manager, kms) — mocks via `__setClientFactoryForTesting` injection hooks.
- 5 integration tests auto-skip unless `CORTEX_INTEGRATION_TESTS=true` (read-only GET against `cortex-db-postgres-break-glass-dev`; envelope round-trip against dev `cortex-general-key`).
- `put` integration deferred until F02 exercises it.

**Scope decisions:**

- Rotation explicitly out of scope per P0.7 build prompt (F02 owns).
- Binary payloads deferred (`getBytes` when first binary consumer emerges).
- No `.env.local` fallback — Secret Manager is the single path in all envs.

**Next consumers:** F01 (P1.1) PII encryption, F02 (P1.2) per-tenant key swap of `getKeyForTenant`, P0.9 for super-admin initial password, G01 (P4.4) for Kafka SASL creds.

### P0.9 — Super Admin bootstrap (2026-04-24)

**Shipped:**

- New workspace package `@cortex/bootstrap` (`scripts/bootstrap/`) — CLI + business logic + 14 unit tests
- Migration `0005_bootstrap_admin.sql` with CHECK constraints on `env_created_in` + promoted-consistency
- Drizzle schema `bootstrapAdmin` in `@cortex/canonical-schema` (canonical location for forward AC01 use)
- Terraform secret `cortex-auth-super-admin-initial-{dev,staging}` with CMEK via `cortex-secrets-key` (prod uses WorkOS — no secret)
- Operational runbook `docs/runbooks/super-admin-bootstrap.md` (dev/staging procedure + prod procedure + emergency break-glass + reset)

**Design decisions:**

- Password handling: CLI collects via `@inquirer/prompts`; lib never sees terminal; AC01 hashes with argon2id at promotion time.
- Idempotency: re-run with existing row exits 0 with runbook pointer (no destructive `--force-re-run` flag).
- `password_secret_ref` stores full version name (`projects/.../versions/N`) — pins AC01 promotion to exact version.
- Audit logging: `[BOOTSTRAP-AUDIT]` stderr stub matching `[SECRETS-AUDIT]` precedent (TODO swap when `@cortex/observability` lands).

**Verification:**

- 45 tests pass (14 bootstrap + 31 foundation), incl. password-never-in-logs at type + runtime.
- Terraform applied cleanly to dev + staging; prod skipped per design.

**Next consumer:** AC01 (P2.1) — promotion migration reads `bootstrap_admin` rows, hashes password, writes to users + user_role_assignment.

**Commit:** `51253c7`

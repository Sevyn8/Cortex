# Cortex Build Progress

Last updated: 2026-05-09 (F02 Slice C closed 2026-04-28 — `135c9da`. **F02 Slice D CLOSED 2026-05-09**: D.0 spike `cd285d6`; D.0.5 ADR-HTTP-001 `a685294`; Slice D Planning `3d29027`; D.1 Hono prototype `5236544`; D.2 `tenants.rotateKeys` + worker route `6fcc2b5`; D.3 HTTP API `c451703`; D.4 TF + IAM gap closure + firewall internal-egress `547b7ec`; D.5 invoker IAM allowlist + §7.7 `c4fdc41`; D.4.5 provisioning worker route + OIDC dispatch fix + self-actAs grant + §7.4 dual-pillar `ed86b45`; D.6 Slice D close — convention §7 finalize + §7.8 forensic queries + D.4.5 deferral fold-in + self-tokenCreator grant for offboard signed URLs + 3 D.3 happy paths now active. P1.3 F03 unblocked + scope-decomposed: `docs/planning/f03-temporal-data-engine-scope.md` + `docs/planning/f03-slice-A-scope.md` (A + B ship P1.3; C + D defer to F04 + D04 per multi-phase close timeline). F03 Slice A ✓ at `2d3782e` (bi-temporal authoring DX — lint + scaffold + backfill + convention). **F03 Slice B ✓** at `de84fb4` + fixes `888249d` (§4.20 closure) + `a7c9a23` (asOf test semantics + `diff` `@experimental`). F03 module-row stays unchecked per D4 (per-slice rows; flips at all-4-slices ✓; C + D deferred to F04 + D04). **Branch protection enforced** in same session — `enforce_admins=true` + `required_pull_request_reviews` with count=0; closes the bypass that masked D.6 + Slice B red CI for 3 slices (audit trail: `docs/planning/branch-protection-2026-05-09.md`). Next: F03 Slice B.5 (`diffByKey` — entity-level diff via business-key resolution; scoped at `docs/planning/f03-slice-B5-scope.md`; ~1.5 hr). Operator-driven recovery still pending: re-attach billing on staging+prod per roadmap §2.5a → apply 5 accumulated TF bundles (D.4 firewall + bootstrap KMS + D.5 invoker IAM + D.4.5 self-actAs + D.6 self-tokenCreator).)

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
- [x] P0.6 Observability baseline — Phase 1 DONE 2026-04-24; Phase 2 DONE 2026-04-25; Phase 3 deferred indefinitely
  - [x] Phase 1 operator infrastructure + Phase 8 synthetic validation (2026-04-24)
  - [x] Phase 2 `@cortex/observability` library (2026-04-25, commit `15e5574`)
  - [ ] Phase 3 dashboards — DEFERRED indefinitely (no hard consumer; trigger on operator ask)
- [x] P0.7 Secret Manager + KMS (2026-04-24)
- [x] P0.9 Super Admin bootstrap (2026-04-24)
- [x] P0.10 Audit event emission convention (2026-04-26, commit `0f4a99b`)

## Phase 1 — Display Data Go-Live

### Foundation Layer

- [x] P1.1 F01 Multi-Tenancy (closed 2026-04-26)
  - [x] Slice A — Tenant context + DB isolation (2026-04-25, commit `4811821`)
  - [x] Slice B — Encryption + GCS isolation (2026-04-26, commit `c64192f`)
    - dev applied; staging + prod queued for separate cycles
  - [x] Slice C — Quotas + Compute isolation (2026-04-26, commit `dcc503c`)
    - Workspace: 464 active tests (was 408 pre-Slice-C; +56 quotas, +30 compute-placement)
    - 2 packages shipped: `@cortex/quotas` (56 tests), `@cortex/compute-placement` (30 tests)
    - ADR-COMPUTE-001 (Cloud Run vs K8s) + F02 swap-paths doc + convention doc landed
    - Substrate: NONE NEEDED (`tenant_quota_usage` RLS already correctly shaped from Slice A)
- [ ] P1.2 F02 Tenant Lifecycle — IN FLIGHT (Slices A/B/C closed; Slice D in-flight)
  - [x] Slice A — Provisioning workflow + state machine + stub swaps (2026-04-27, commit `35e1984`)
  - [x] Slice B — Suspension + Resume + §10.15 contention test (2026-04-27, commit `da1314d`)
  - [x] Slice C — Offboarding + termination + force-terminate + legal-hold + TF (2026-04-28; closes Slice C at `135c9da`)
    - 6 commits: `940a616` migration 0011 → `5716d4f` offboard → `cab6329` terminate → `c377f1b` forceTerminate + legalHolds → `e6e44c9` TF wiring → `135c9da` convention §6 final expansion
    - Test surface: +87 across Slice C (foundation +10 legal_hold; tenant-context +77). Tenant-context now 240/240.
    - Audit catalog: 14 actions registered (5 Slice A + 6 F02 lifecycle + 3 Slice C 7.5 — TENANT_FORCE_TERMINATED, LEGAL_HOLD_SET, LEGAL_HOLD_RELEASED).
    - TF: `lifecycle-queue` + `provisioning-queue` + `cortex-export-signer-{env}` + `tenant-lifecycle-runtime` SAs wired per env (sub-phase 7.6). `make tf-plan-{env}` validates; apply pending operator action.
    - 6 SC# locks + 25 Q-NEW# locks resolved across the slice.
  - [x] Slice D — Key rotation + HTTP API + Cloud Run TF — CLOSED (D.1 ✓ + D.2 ✓ + D.3 ✓ + D.4 ✓ + D.4.5 ✓ + D.5 ✓ + D.6 ✓ — Slice D closed 2026-05-09)
    - [x] D.0 Hono prod-readiness spike (2026-04-28, commit `cd285d6`) — GO-with-conditions; establishes `docs/spikes/` convention
    - [x] D.0.5 ADR-HTTP-001 (2026-04-29, commit `a685294`) — codifies Hono + 6 binding conditions; resolves roadmap §10.11
    - [x] Planning sub-phase 1 (2026-04-29, commit `3d29027`) — `docs/planning/f02-slice-d-scope.md`: 10 SD# locks + 12 Q-NEW-D# items + 6-sub-phase plan (D.1 → D.6); convention §7 outline
    - [x] D.1 Hono prototype (2026-04-29, commit `5236544`) — `apps/tenant-lifecycle-api/` (`/health` + `/v1/tenants/{id}` + `/v1/test/slow-5s`); ADR-HTTP-001 Condition 2 PASS row 2 on framework-attributable OTel cost (mean 142.7 ms, max 187.9 ms; n=2 smoke samples; ADR amendment scopes Condition 2 to framework cost, defers platform cost to convention §7.1 `min_instances=1` posture); Condition 3 PASS row 1 on graceful-shutdown evidence (3/3 inflight=200, served by old revision, handler delta 5.8–6.8 ms). Squashed from 10 feature-branch commits including 6 fixes (Cloud SQL IAM auth, scripts CWD, Dockerfile pnpm v10 `--legacy`, GCP label format, workspace `dist/` emit, measurement-script correctness) + 2 HOLD #2 artifacts (ADR-HTTP-001 Condition 2 scope clarification, convention §7.1 production-posture lock). D.2+ unblocked.
    - [x] D.2 Key rotation workflow + worker route (2026-04-29, commit `6fcc2b5`) — `tenants.rotateKeys` library workflow (single-tx 8-step phase sequence; FOR UPDATE concurrency guard; 24-h cooldown idempotency; post-commit KMS scheduleDestroy with best-effort semantics) + `kmsAdmin.rotateCryptoKey` + `scheduleCryptoKeyVersionDestroy` primitives in `@cortex/secrets` + `POST /v1/_workers/key-rotation` worker route (OIDC validation per ADR-LIFECYCLE-001 §3; injectable validator for tests) + `TenantRotationCooldownError` (new error class). Audit catalog UNCHANGED — `TENANT_KEY_ROTATED` was registered Slice A; emits via existing entry with workspace-standard `before_state`/`after_state` envelope. App tsconfig split (`tsconfig.build.json` for emit; `tsconfig.json` for typecheck/lint includes test/). Convention §7 grew ~30 → ~350 lines: §7.1.1 (rotation workflow shape), §7.2 (dual-key overlap mechanics), §7.3 (cadence + on-demand path + emergency runbook), §7.4 (worker route + Cloud Tasks status mapping; D.4 extends), §7.5 (failure modes + stuck-rotation runbook; D.4 extends). Tests: 253/253 (rotate-keys 13 + worker route 9 + existing 231).
    - [x] D.3 HTTP API — 12 endpoints (2026-04-29, commit `c451703`) — `apps/tenant-lifecycle-api/src/routes/v1/tenants.ts` ships 11 new route handlers + the lifted `GET /v1/tenants/:id` from D.1; each is a thin wrapper around an existing library function per SD7. New library function `tenants.approveDedicatedDb` covers the Q-OPEN-6 dedicated-DB approval gate. Audit catalog grows 14 → 15 (`TENANT_DEDICATED_DB_APPROVED`). `BuildV1TenantRoutesOptions.superAdminGuard` DI seam marks the AC01 extension point for the 3 super-admin endpoints (list / force-terminate / approve-dedicated-db); Phase 1 placeholder always passes; tests inject `REJECTING_SUPER_ADMIN_GUARD` to verify wiring. Workspace error-mapper extended with observability logging on the unhandled-error fallback (production response stays generic; server-side logs capture err.message + err.stack + correlation_id for D.3+ + AC01 diagnostics). Convention §7.6 lands as a peer subsection (~510 lines total in §7) with the 12-endpoint table + naming/envelope conventions + status-code map + on-demand vs scheduled rotation actor distinction + curl runbook; D.5 → §7.7, D.6 → §7.8 in forward-looking text. Tests: 294 active + 1 skipped passing (was 285 + 1; +9 D.3 + +1 audit-actions describe). Three happy-path skips tracked for D.4 deploy smoke (offboard, terminate, force-terminate — library-layer covered with cascade stubs).
    - [x] D.4 TF: `tenant-cloud-run-service` module + IAM gap closure + migration 0012 + ADR-INFRA-003 firewall posture amendment (4 → 5 rules; new `cortex-allow-internal-egress`) + worker-URL declaratization (2026-05-08, commit `547b7ec`) — `infra/terraform/modules/tenant-cloud-run-service/` (mode=shared|tenant; vpc_access wired; lifecycle.ignore_changes preserves out-of-band image SHAs); `infra/terraform/environments/{dev,staging,prod}/main.tf` instantiate the module + cross-project AR grants + `key-rotation-queue` per env; migration 0012 GRANTs runtime-SA SQL perms (CONNECT/USAGE/SELECT/INSERT/UPDATE/DELETE on Phase 1 control-plane tables); ADR-INFRA-003 §Firewall posture amended after diagnosis showed connector → PSA TCP:3307 traffic was caught by deny-all-egress at 65534 (Cloud Build private-pool worked because of separate egress path); 5 firewall rules deployed in dev, declared for staging+prod (deferred apply per BILLING_DISABLED — see roadmap §2.5a). Worker-URL declarativization closed a separate latent gap surfaced at gate evidence: env-level main.tf comment said worker URLs were "set out-of-band by deploy-dev.sh" but deploy-dev.sh is image-only; D.1-D.3 only exercised GET endpoints so the POST-create 500 went unnoticed; new `tenant_lifecycle_service_url` var + extra_env_vars merge fixes it. Recovery from 9-day billing-disabled gap surfaced 3 latent infra recoveries (VPC connector ERROR → recreate; Cloud Run revision binding stale → bump 00013→00017; Service Networking peering disconnected → forced update). Gate evidence: `docs/planning/d4-gate-evidence.md` — D.4 IAM gap closure end-to-end PASS via curl 1; lifecycle routes reachable + state-machine guards work (curls 2/3/4 return 409 — correct for PROVISIONING-state tenant); lifecycle happy-paths + §7.4 contract message DEFERRED to sub-phase 4.3 (provisioning worker that flips PROVISIONING → READY not yet built). Tests UNCHANGED at 294 active + 1 skipped (no app-layer code touched). Squash bundles 5 prior commits + 12 working-tree files + 2 new files (24 files, 1,667 inserts, 129 deletes).
    - [x] D.4.5 Provisioning worker — HTTP route + OIDC dispatch fix + self-actAs IAM grant + convention §7.4 restructure (2026-05-08, commit `ed86b45`) — `apps/tenant-lifecycle-api/src/routes/workers/provisioning.ts` ships the HTTP wrapper for Slice A's pre-existing `provisioningWorker` library function; OIDC validator extracted to `_shared/oidc.ts` (parallel to D.2's key-rotation). Worker route at `POST /v1/_workers/provision` (matches TF env-var + test-helper convention); snake_case wire body schema with strict extra-keys reject; transforms to camelCase `ProvisioningTaskPayload` at the route boundary. 11 unit tests + 1 live integration test (skipped without `CORTEX_INTEGRATION_TESTS=1` per the P0.7 + D.5 precedent). Three reconciliation surfaces fixed in-flight: (1) URL drift between route + env-var; (2) `dispatchCloudTask` was missing `oidcToken` field — every dispatched task got 403 at Cloud Run platform; added `oidcServiceAccountEmail?` to `DispatchOptions` + threaded through provision/offboard call sites + fix benefits D.6's lifecycle worker; (3) Self-actAs IAM grant — Cloud Tasks impersonating runtime SA to mint OIDC tokens needs `iam.serviceAccounts.actAs` on the same SA (Q-NEW-D-11 Option 1 self-loop); new TF binding `lifecycle_runtime_self_user` in all 3 envs (dev applied; staging+prod deferred per roadmap §2.5a). Convention §7.4 restructured from single-pillar (key-rotation only) into dual-pillar: §7.4.0 shared pattern (OIDC, snake_case wire convention, status-mapping, AR-pull, deploy checklist), §7.4.1 key-rotation (D.2 content compacted), §7.4.2 provisioning (new). Live gate evidence: PROVISIONING → ACTIVE in **637ms** end-to-end via Cloud Tasks → Cloud Run → state machine. The 3 D.3 deferred-skip happy paths NOT re-enabled at unit-test layer per HOLD-#2 reconciliation — `@cortex/blob-storage` lacks a client-factory mock seam (KMS-style); Option B taken (live integration is the happy-path evidence; route-level `cascadeOverrides?` DI deferred to D.6). Gate evidence: `docs/planning/d4.5-gate-evidence.md`. Tests: 296 active + 1 skipped (was 294 + 1 at D.5 close; +12 new — 11 worker route + 1 OIDC dispatch test in provision.spec.ts; offset by no skip-flips).
    - [x] D.5 IAM authz — Cloud Run invoker IAM allowlist + 3-case integration test + convention §7.7 (2026-05-08, commit `c4fdc41`) — `infra/terraform/modules/tenant-cloud-run-service/` adds `var.invoker_service_accounts` + `var.invoker_user_emails` + two `google_cloud_run_v2_service_iam_member` resources (additive `for_each` per CLAUDE.md). Env-level wiring grants `roles/run.invoker` to 3 principals: `cortex-tf-admin-{env}` (operator + integration-test path), `tenant-lifecycle-runtime-{env}` (Cloud Tasks → Cloud Run worker dispatch per Q-NEW-D-11 Option 1; required for D.2's deployed key-rotation worker route + D.4.5's future provisioning worker), `var.operator_emails` (break-glass). Live IAM policy verified: 3 explicit members, no `allUsers`, no `--allow-unauthenticated`. Pre-D.5 state: NO bindings on the live service — reachable only via project-IAM inheritance (operator's `cortex-admins` group); D.5 makes the allowlist explicit + declarative + auditable. Apply: dev only (3 added, 1 changed, 0 destroyed); staging+prod TF declared, apply deferred per roadmap §2.5a (BILLING_DISABLED). New integration test pattern: `apps/tenant-lifecycle-api/test/integration/iam-authz.integration.spec.ts` shells out to `gcloud auth print-identity-token`, hits LIVE Cloud Run URL, asserts 403/200/200; skipped without `CORTEX_INTEGRATION_TESTS=1` env flag (matches P0.7 `packages/secrets/test/integration/` precedent). 3/3 cases PASS live (verified post-apply). Convention §7.7 grew from D.4 placeholder (~30 lines) to 5-subsection real content (~150 lines) covering invoker IAM model, TF wiring shape, the 3-case test pattern, what's deliberately NOT in D.5, and forward-looking D.6 + AC01 work. Gate evidence: `docs/planning/d5-gate-evidence.md`.
    - [x] D.6 Slice D close — convention §7 finalize (drift fixes + new §7.8 forensic queries; 7 top-level subsections matching §6 density) + D.4.5 deferral fold-in (route-level `testHooks?.storage` DI seam on `BuildV1TenantRoutesOptions` threaded through offboard / terminate / force-terminate handlers + `inMemoryStorage()` helper covering `bucket().deleteFiles()` + `bucket().file().save()` + `getSignedUrl()`; 3 D.3 happy-path tests now active — 1 skip-flip in offboard.spec.ts + 2 new in terminate / force-terminate; lint + typecheck clean; live runs blocked by pre-existing local-DB password mismatch, exercised end-to-end via §7.4 contract evidence curls instead) + 2 in-flight reconciliations (`db-proxy-dev` Makefile target fixed to `--private-ip` per ADR-INFRA-005 — HOLD-#1 (f) recommendation reversed; new `lifecycle_runtime_self_token_creator` IAM binding for offboard's V4 signed-URL `signBlob` per convention §6.1 deferred-app-change pattern, dev applied, staging+prod TF declared) + CLAUDE.md `apps/<workload>-api/` workspace-layout note (per SD5) + future-roadmap §4.19 tenant-lifecycle DLQ deferral entry + TF prompt label bump `p1-2-slice-d-d5` → `p1-2-slice-d-d6` across 3 envs (label-only; covered by `lifecycle.ignore_changes`). Live §7.4 contract evidence: provision → ACTIVE → offboard 200 → terminate-before-grace 409 GRACE_NOT_ELAPSED → force-terminate 200 (full chain; gate evidence §2). Tests: 299 active + 0 skipped (was 296 + 1 at D.4.5 close; +3 new happy paths, −1 skipped). Gate evidence: `docs/planning/d6-gate-evidence.md`. (2026-05-09, commit `0b7a6b1`)
- [ ] P1.3 F03 Temporal Data Engine — multi-phase F-feature (P1.3 ships A + B; C + D defer to F04 + D04). Per Q-NEW-F03-1 / Decision D4: per-slice rows; module row flips ✓ when ALL 4 slice rows are ✓. Scope: `docs/planning/f03-temporal-data-engine-scope.md`.
  - [x] F03 Slice A — Bi-temporal authoring DX (2026-05-09, commit `2d3782e`) — `services/foundation/scripts/lint-bi-temporal.mjs` (fail-closed CI lint; SD5 = exception-list-with-opt-out; allowlist of 6 bookkeeping tables) + `services/foundation/scripts/scaffold-bitemporal.mjs` + Makefile target `db-scaffold-bitemporal` (SD6 = raw-SQL-template; Q-NEW-F03A-1 synthesis = WITH_WRAPPERS=y default per operator counter, generates per-table `as_of_valid` / `as_of_latest` / `history` wrappers consistent across all bi-temporal tables) + migration 0013 `cortex.backfill_bitemporal()` PL/pgSQL helper (idempotent; future-proofs reclassification + external imports) + CLAUDE.md `### Bi-temporal table convention` subsection (3-bullet pattern + WITH_WRAPPERS flag semantics + cross-refs to both F03 planning docs) + 14 unit tests PASS (lint 7 + scaffold 7) + lint-staged `*.sql` glob + first CI lint step in the repo (Q-NEW-F03A-2 = pre-commit AND CI). Two in-flight reconciliations closed in same commit: (a) 0002 header recipe binding correction (post-0006 — `BEFORE INSERT OR UPDATE OR DELETE`); (b) first-CI-lint-step pattern establishment. Roadmap §4.20 carry-over (local DB password) hit again; CI exercises the backfill spec via ephemeral Postgres on push. Gate evidence: `docs/planning/f03-slice-A-gate-evidence.md`.
  - [x] F03 Slice B — Temporal query library (2026-05-09, commit `de84fb4` + fixes `888249d` + `a7c9a23`) — `@cortex/temporal-query` package ships 5 functions (`asOf / currentState / history / between / diff`) over `cortex.at_time_t`, `Queryable` interface seam (Q-NEW-F03B-5 productization-critical lock; no `pg.Pool` import in public API), explicit `tenantId` parameter on every call (Q-NEW-F03B-6; RLS as defense-in-depth backstop), closed-open `[t1, t2)` ranges matching `tstzrange` convention (Q-NEW-F03B-3), nullable returns for single-row + `T[]` for collection (Q-NEW-F03B-4), regex-validated table names (`/^[a-z][a-z0-9_]{0,62}$/` — Postgres NAMEDATALEN-1 limit; SQL-injection guard since table names can't be parameterized in prepared statements). 13 unit tests PASS (5 per-function + F03 spec acceptance + tenant-scope + null semantics + table-name validation). B.0 carve-out: `@cortex/test-db-harness` extracted from duplicated harness logic in `services/foundation/test/helpers/db.ts` + `packages/tenant-context/test/helpers/db.ts`; tenant-bound shims (`withBoundClient`, `withTwoBoundClients`) stay in tenant-context to preserve leafness. **Three in-flight reconciliations closed:** (1) **Roadmap §4.20** (local DB credentials) — closed at `888249d`; compose Postgres realigned to CI shape (`postgres/testpw/cortex`); local `pnpm vitest run` now mirrors CI exactly; D.6 + Slice B bugs that shipped red were the motivating incidents. (2) **`asOf` test semantics** — test was using documented contract incorrectly (default `asOfSystemTs=now()` doesn't reach SCD-closed prior versions); fixed at `a7c9a23` to pass `tBetween` as both anchors. JSDoc `@example` block in `as-of.ts` documents both query shapes side-by-side (current-belief vs historical-snapshot). (3) **`diff` marked `@experimental`** — row-version-scoped (id-based), not entity-level. Headline F03 "what changed about this product over time" use case requires business-key resolution which the library deliberately doesn't carry; deferred to **Slice B.5 (`diffByKey`)** — scoped at `docs/planning/f03-slice-B5-scope.md`. CLAUDE.md "Querying bi-temporal data" subsection extended with both caveats. **Branch protection enforcement** also closed in this PR (`enforce_admins=true` + `required_pull_request_reviews` with count=0; D.6's bypass-on-push pattern was the structural culprit alongside §4.20). Gate evidence: `docs/planning/f03-slice-B-gate-evidence.md`. F03 module-row stays unchecked per D4 (Slice C + D deferred to F04 / D04).
  - [ ] F03 Slice C — SCD policy configuration (Type 1/2/3/4/6 per entity-type from F04). **DEFERRED — blocked by F04.**
  - [ ] F03 Slice D — Late-arriving data (grace period + flag + manual review queue + Gold-layer re-mat). **DEFERRED — blocked by D04 + S01 + SCR-08.**
- [x] P1.4 F04 Configuration Plane — module CLOSED 2026-05-10. 5 slices shipped: A storage substrate (`@cortex/config-plane` + `tenant_config_version` reshape + Zod registry + `getConfig`); B lifecycle (createDraft / updateDraft / validateDraft / promoteDraft / rollbackVersion / discardDraft + 6 audit verbs); C layered resolution + per-process LRU cache (`resolveConfig` + `registerConfigConsumer` + active invalidation); D impact analysis + breaking-change blocker (`analyzeImpact` + `ImpactBlockedError` + `CONFIG_PROMOTE_BLOCKED` REJECT verb); E git-sync stub (Phase 2 deferred per build-prompt §F04 §4 — `exportToYaml` / `importFromYaml` throw `GitSyncNotImplementedError`). Day-of lineage: PRs #3 (planning) → #4 (A) → #5 (B) → #6 (F03 Slice C as cross-feature pre-promote-safety) → #7 (chore §1.14) → #8 (C) → #9 (D) → #10 (E + module close). 121/121 config-plane tests; 84/84 foundation regression-stable. Gate evidence: `docs/planning/f04-gate-evidence.md`. **Downstream queue unblocked:** P1.5 F05 Schema Evolution, P1.6 Feature Flags (`@cortex/feature-flags` is the named first consumer per D6), D04 quality rule library, UX01 theme tokens, IC01 vertical-package selection, IC02 i18n, AC02 hierarchy schema, PR06 retention policies.
- [ ] P1.5 F05 Schema Evolution Engine — scoping PR (chore-p1-5-f05-scope) lands D1-D12 locks + 4 slice shells. Slice A substrate/classifier next.
- [ ] P1.6 Feature Flags — scoping PR (chore-p1-6-feature-flags-scope) lands D1-D8 locks + 3 slice shells. Slice A core surface next.

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

### P0.6 Phase 2 — @cortex/observability library (2026-04-25)

**Shipped:**

- New package `packages/observability/` — OTel-native logger / tracer / metrics + correlation context + redaction + grpc/http middleware adapters + pubsub wrapper. ~77 unit tests.
- `createLogger` consumes a `ContextProvider`; `composeContextProviders(defaultContextProvider, tenantContextProvider)` injects `tenant_id` into every log record (cycle-defensive — see roadmap §4.13 resolution).
- ADR-OBS-001 finalized; ADR-OBS-003 (PII redaction) shipped.
- `@cortex/secrets` and `@cortex/audit-events` audit emitters swapped to `[OBS-AUDIT]` shape via `createLogger` — retiring the `[SECRETS-AUDIT]` / `[BOOTSTRAP-AUDIT]` stderr-JSON stubs from P0.7 / P0.9.

**Commit:** `15e5574`. Backfilled into resolution markers via `3cb738d`.

### P0.10 — @cortex/audit-events library + tenant-context migration (2026-04-26)

**Shipped:**

- New package `packages/audit-events/` — verb-driven discriminated union for `emitAuditEvent(tx, params)`, action-catalog registration via `registerAuditActions([...] as const)`, canonicalization + RLS-binding + `clock_timestamp()` server-stamping per planning-doc Decision 11.
- `@cortex/tenant-context` adopts the library; `TENANT_*` action catalog moved into `audit-actions.ts` (vitest-safe — no top-level `registerAuditActions(...)` in the audit emit path).
- Migration `0008_audit_event_actor_type_agent.sql` — extends `audit_event.actor_type` CHECK to add `'agent'` per ADR-AU-001.
- `tenants.create`'s 3-event chain (`TENANT_CREATED` + `TENANT_KMS_KEY_BOUND` + optional `TENANT_CONFIG_VERSION_CREATED`) emits via the library; Phase 0 closes with this commit.

**Commit:** `0f4a99b`. Phase 0 close marker: `b1a23a1`.

### F01 — Multi-Tenancy (closed 2026-04-26)

#### Slice A — Tenant context + DB isolation (2026-04-25, commit `4811821`)

**Shipped:**

- Migration `0007_control_plane_tables.sql` — 4 control-plane tables: `tenant`, `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`. RLS on the latter three; `tenant` is the registry (no RLS — circular).
- New package `@cortex/tenant-context` — async-local tenant context (`withTenantContext` / `getTenantOrThrow`), DB session binding (`bindTenantToDbSession` / `withTenantDbClient`), framework-agnostic HTTP middleware with Hono + Express adapters, `tenants.{create, get, getByExternalId, list, update, setStatus}` CRUD with audit emission.
- 3 new ADRs: `ADR-DB-002` (RLS session-variable contract), `ADR-AU-001` (audit-events library shape — co-shipped with tenants.ts as the first audit consumer).
- Convention doc `docs/architecture/tenant-lifecycle-convention.md` — initial sections (state machine, transitions, RLS bind requirements).

#### Slice B — Encryption + GCS isolation (2026-04-26, commit `c64192f`)

**Shipped:**

- New package `@cortex/encryption` — envelope encryption (AES-256-GCM with `tenantId` AAD per ADR-INFRA-007). Wraps the Phase 1 `getKeyForTenant` stub from `@cortex/secrets`.
- New package `@cortex/blob-storage` — path validators (`buildFullObjectPath`, `assertObjectInTenantPrefix`, `getTenantPrefix`, `getTenantBucketName`) + V4 signed-URL signer (`createSignedUrlSigner`). Object emission paths deferred until first F-series consumer.
- Migration `0009_tenant_kms_key_writes_policy.sql` — extends `tenant_kms_key` RLS to FOR ALL with WITH CHECK (Slice B writes the row in `tenants.create` under the caller's RLS-bound role).
- TF: `tenant-data-bucket` module — per-env `cortex-{env}-tenant-data` bucket with bucket-level CMEK + `tenant-data-runtime` SA + GCS service-agent CMEK grant per ADR-INFRA-002 Quirk 1.
- 1 new ADR: `ADR-INFRA-007` (per-tenant CMEK migration path; Phase 1 stub via env-level key + AAD; F02 swaps the resolver).

**Deviation note:** dev applied; staging + prod queued for separate cycles.

#### Slice C — Quotas + Compute placement (2026-04-26, commit `dcc503c`; backfill `123c58e`)

**Shipped:**

- New package `@cortex/quotas` — token bucket per (tenant, resource_class) backed by `tenant_quota_usage`; HTTP middleware (framework-agnostic + Hono/Express adapters); 429 + `Retry-After` + `QUOTA_EXCEEDED` audit on rejection.
- New package `@cortex/compute-placement` — `getComputePlacement(tenantId, workload, env)` returns `ComputePlacement`. Phase 1 always returns `shared`; F02 swaps to branch on `tenant.tier`.
- 1 new ADR: `ADR-COMPUTE-001` (Cloud Run vs K8s; service-name format `{workload}-shared` / `{workload}-tenant-{uuid}`).
- Convention doc `docs/architecture/quotas-compute-placement-convention.md` + F02 swap-paths doc.

**Substrate:** NONE NEEDED (`tenant_quota_usage` RLS already correctly shaped from Slice A migration 0007).

**Workspace test count at F01 close:** 464 active tests across 10 packages.

### F02 — Tenant Lifecycle (in flight)

#### Slice A — Provisioning + 3 stub swaps (2026-04-27, commit `35e1984`)

**Shipped:**

- `tenants.provision` workflow: ENTERPRISE → REQUESTED (manual approval gate per Q-OPEN-6); STANDARD → PROVISIONING. Cloud Tasks dispatch on `provisioning-queue` with `taskId='provisioning-{tenant_id}'` (D5 dedup).
- `provisioning-worker.ts` runs the state machine: REQUESTED → PROVISIONING → READY → ACTIVE. Smoke-test via `runSmokeTest`. Hard rollback via `cleanupFailedProvisioning` on smoke-test failure (SA10 + SA14).
- 3 Phase 1 resolver stubs swapped to real implementations:
  - `getKeyForTenant(tenantId)` in `@cortex/secrets` queries `tenant_kms_key` (table populated by Slice B's `tenants.create`).
  - `getQuotaConfig(tier, resourceClass, ctx?)` in `@cortex/quotas` becomes async; consults `tenant_config_version.config_json.quotas[resource_class]` with fallback to `DEFAULT_TIER_QUOTAS`.
  - `getComputePlacement(params)` in `@cortex/compute-placement` branches on `tenant.tier` for ENTERPRISE.
- Migration `0010_tenant_lifecycle_metadata.sql` — extends `tenant.status` CHECK to 7 values (REQUESTED, PROVISIONING, READY, ACTIVE, SUSPENDED, OFFBOARDING, TERMINATED) + 5 lifecycle metadata columns (`last_key_rotated_at`, `terminated_at`, `offboarding_grace_until`, `legal_hold`, `dedicated_db_approved`).
- 1 new ADR: `ADR-LIFECYCLE-001` (state machine + Cloud Tasks orchestration).
- Convention doc `docs/architecture/tenant-lifecycle-convention.md` extended (§1–§4 + cleanup-vector resolution per §4.15/§4.16/§4.17).
- 4 cleanup vectors resolved (§4.13 cycle decoupling RESOLVED via static observability imports — no longer dynamic-imported as cycle defense; §4.15 redundant `getKeyForTenant` consult removed; §4.16 dead logger plumbing in `@cortex/quotas` removed; §4.17 swap-paths doc retired into convention appendix).

#### Slice B — Suspension + Resume + §10.15 contention test (2026-04-27, commit `da1314d`)

**Shipped:**

- `tenants.suspend(db, id, reason, ctx)` — flips ACTIVE → SUSPENDED; emits `TENANT_SUSPENDED` audit event with `payload.reason`. Per SB1 lock: dedicated domain action (NOT `TENANT_STATUS_CHANGED`) for cascade-event handle to AC01 / S15 / S17 (push-style event sourcing).
- `tenants.resume(db, id, ctx)` — SUSPENDED → ACTIVE; emits `TENANT_STATUS_CHANGED` (reversible inverse with no cascade subscribers).
- Both helpers idempotent per SB5 Option α (already-target-state returns current row, no audit re-emit).
- §10.15 contention test (forcing function resolved): `withTwoBoundClients` test helper exercises the `SELECT ... FOR UPDATE` row lock under two concurrent transactions; barrier-based interleaving verifies tx2 blocks until tx1 commits.

#### Slice C — Offboarding + termination + force-terminate + legal-hold + TF (closed 2026-04-28, `135c9da`)

**Shipped (6 commits):**

- `940a616` — Migration `0011_legal_hold_table.sql` (granular per-record / per-data-class hold path; 3 CHECK constraints; 2 partial indexes; RLS-protected) + Drizzle schema (`legalHold` pgTable).
- `5716d4f` — `dispatchCloudTask` extended with optional `scheduleTime: Date` (mapped to Cloud Tasks Timestamp); `generateExportArchive` utility (gzipped JSON Lines, schema-versioned envelope, 6 entity types) using `@cortex/blob-storage`'s signer + GCS upload; `tenants.offboard(db, id, options, ctx)` 4-phase workflow (preflight → archive → state-transition-and-audit-emit txn → Cloud Task dispatch). Workspace cycle prevention: dropped 3 unused `@cortex/*` deps from `@cortex/blob-storage`.
- `cab6329` — `tenants.terminate(db, id, ctx, options?)` 4-phase + 5-step cascade (Cloud Run STUB → GCS recursive delete → Cloud SQL STUB → shared-DB single-txn cascade → KMS tombstone-only). Soft-retain tombstone semantics per Q-NEW-C8: `status='TERMINATED' + terminated_at` UPDATE; children hard-deleted; `tenants.get`/`getByExternalId` filter to `TenantNotFoundError`. New `TenantLegalHoldError` + `TenantGraceNotElapsedError` classes.
- `c377f1b` — `tenants.forceTerminate(db, id, reason, ctx, options?)` Super Admin override: skips legal-hold + grace-period checks; captures bypassed details in `payload.override_metadata` for forensic attribution. `legalHolds.set` + `legalHolds.release` helpers (3-scope discriminated-union options; idempotent release; cross-tenant access fails closed). 3 new audit catalog actions: `TENANT_FORCE_TERMINATED`, `LEGAL_HOLD_SET`, `LEGAL_HOLD_RELEASED` (catalog grew 11 → 14 actions).
- `e6e44c9` — TF: `lifecycle-queue` + `provisioning-queue` instantiated per env (first env-level Cloud Tasks instantiation); `tenant-lifecycle-runtime` SA inline per env (observer pattern); new module `cortex-signer-sa` (per-env `cortex-export-signer-{env}` SA + TokenCreator grant from runtime SA + `storage.objectViewer` on tenant-data bucket). `make tf-plan-{env}` validates; apply pending operator action.
- `135c9da` — Convention §6 final expansion: 4 → 7 subsections (added §6.5 idempotency, §6.6 failure recovery, §6.7 forensic queries — 8 SQL examples); §6.1 drift fixes (archive format + URL TTL split + audit emission shape); §9.1 audit catalog table refreshed.

**Slice C numbers:**

- 6 commits, 1 working day. Test surface: +87 tests (foundation +10 legal_hold; tenant-context +77 — cloud-tasks +5, export-archive +11, offboard +17, terminate +19, audit-actions +3, legal-holds +17, force-terminate +15). **Tenant-context: 240/240.**
- 6 SC# locks + 25 Q-NEW# locks resolved.
- Convention `tenant-lifecycle-convention.md` §6: 4 → 7 subsections; 254 → 522 lines.

**5 deferred items traveling with Slice C** (tracked, not scheduled):

- `tenants.regenerateOffboardingArchiveUrl` — future helper for refreshing 7-day signed URLs; documented in §6.1; implementation lands when first production offboarding requires it (Phase 1 has 0 production tenants).
- GCS lifecycle policy for 30-day object retention — future TF in `tenant-data-bucket` module; documented in §6.1; lands when first production tenant offboards.
- `export-archive.ts` SA impersonation — switch from default ADC signing to `GoogleAuth({ targetPrincipal: <signerSAEmail> })`. TF for the signer SA + IAM grants are already in place per sub-phase 7.6; no infrastructure rollout required when code change lands.
- §1.3 transition-table TBDs in convention doc — separate convention §1 cleanup pass.
- audit-event tamper-resistance hardening for parallelism flake (`suspend-resume.spec.ts:343`) — per-tenant sequence column or per-tx counter as secondary order key. Reproduces ~1-in-3 full local runs; CI hasn't reproduced.

#### Slice D — Key rotation + HTTP API + Cloud Run TF (in flight)

**D.0 — Hono prod-readiness spike (2026-04-28, commit `cd285d6`):**

- New convention established: `docs/spikes/` for doc-only time-boxed investigations. First entry.
- 12-category Hono evaluation across maturity / Cloud Run fit / TypeScript fit / OTel / logging / error handling / tenant-context middleware / audit lifecycle / RLS lifecycle / validation / testing / operational. Outcome: 8 green / 4 yellow / 0 red. Recommendation: GO with 6 conditions.

**D.0.5 — ADR-HTTP-001 (2026-04-29, commit `a685294`):**

- New ADR series: `HTTP-*`. ADR-HTTP-001 codifies Hono as the HTTP framework + the 6 binding conditions:
  1. Pin `^4.x` minor-version range; major bumps reopen the ADR.
  2. D.1 prototype measures cold-start p95 via OTel; reopen if > 500ms.
  3. D.1 verifies `@hono/node-server` graceful shutdown within Cloud Run's 10s SIGTERM window (per gh:honojs/hono#3104).
  4. Logging stack: `hono-pino`.
  5. Error response shape: `hono-problem-details` (RFC 9457) + workspace-extended `{code, message, correlation_id, details?}` envelope.
  6. `@hono/zod-validator` ↔ Zod 4 coupling tracked as roadmap item.
- Resolves roadmap §10.11 (HTTP framework forcing function).

**D.1 + D.2+ pending.** D.1 prototype must satisfy Conditions 2 + 3 before D.2+ implementation begins on `main`.

**Slice D scope (per planning doc lines 302+):**

- `tenants.rotateKeys(tenantId, ctx)` — 90-day default + on-demand; dual-key overlap window.
- HTTP API for 9 endpoints (provision / suspend / resume / offboard / terminate / forceTerminate / rotateKeys / legalHolds.set + release).
- TF: `infra/terraform/modules/tenant-cloud-run-service/` (generic per-tenant Cloud Run; D10).
- TF: `key-rotation-queue` Cloud Tasks queue.
- Cloud Run service-to-service IAM authz (D8).

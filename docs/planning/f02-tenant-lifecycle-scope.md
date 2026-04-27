# F02 Tenant Lifecycle Manager — Scope

**Status:** Decisions locked 2026-04-27; implementation queued
**Scoped:** 2026-04-27
**Decisions locked:** 2026-04-27
**Primary sources:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.2 (lines 997–1050), Cortex v2.2 Spec §F02
**Companion ADRs (existing):** ADR-COMPUTE-001 (Cloud Run vs K8s), ADR-INFRA-007 (per-tenant CMEK substrate), ADR-AU-001 (audit events), ADR-DB-002 (RLS baseline)
**Companion artifacts (produced by F02):**

- ADR-LIFECYCLE-001 (state machine + Cloud Tasks; lands Slice A — see Appendix A)
- `docs/architecture/tenant-lifecycle-convention.md` (lands Slice A; absorbs swap-paths doc per D11 — see Appendix B)
- Migration 0008 (`tenant.status` enum extension + lifecycle metadata + `dedicated_db_approved`; Slice A)
- Migration 0009 (legal_hold table; Slice C)
- `infra/terraform/modules/tenant-cloud-run-service/` (generic per-tenant Cloud Run TF; Slice D)

---

## Context

F02 closes Phase 1.2 — full tenant lifecycle on top of F01's substrate. Five capabilities per the build prompt:

1. **Provisioning pipeline** — REQUESTED → PROVISIONING → READY; idempotent + transactional + async (Cloud Tasks).
2. **Suspension** — status flip + session revoke + write-block + scheduled-job halt + downstream cascade.
3. **Offboarding & export** — signed-URL archive (30-day TTL) + grace period + scheduled termination.
4. **Termination** — tenant-scoped delete across all modules + KMS key tombstone; legal-hold guards.
5. **Key rotation** — 90-day default + on-demand; zero-downtime overlap window.

F02 is also the first F-series module that exercises HTTP — the build prompt references Platform Ops Dashboard (SCR-24) and Onboarding Wizard (W01) as upstream consumers — and the first to ship Cloud Run service provisioning.

### Substrate from F01 already in place

- `tenant` table with `tier`, `status` (CHECK constraint covers `PROVISIONING|ACTIVE|SUSPENDED|TERMINATED` today; F02 extends).
- `tenant_config_version` table with correct RLS posture (`FOR ALL` + `WITH CHECK`); F04 will be its primary consumer, F02 writes overrides.
- `tenant_kms_key` table populated by Slice B's `tenants.create`; F02 swaps the reader (`getKeyForTenant`) to actually consult it.
- `tenant_quota_usage` — Slice C consumer; F02 writes per-tenant overrides via `tenant_config_version`.
- `tenants.{create, get, getByExternalId, list, update, setStatus}` from `@cortex/tenant-context`. F02 layers lifecycle workflows on top; `tenants.create` already emits the 3-event audit chain.
- 5 audit actions registered: `TENANT_CREATED`, `TENANT_UPDATED`, `TENANT_STATUS_CHANGED`, `TENANT_CONFIG_VERSION_CREATED`, `TENANT_KMS_KEY_BOUND`.
- Three Phase 1 resolver stubs ready for swap: `getKeyForTenant` (Slice B), `getQuotaConfig` (Slice C), `getComputePlacement` (Slice C).
- Workspace cycle topology clean (commit `ebb14ca`, roadmap §4.13 resolved).

### Substrate F02 must add

- Migration 0008: extend `tenant.status` CHECK to include `REQUESTED`, `READY`, `OFFBOARDING`. Plus lifecycle metadata columns (per D7).
- Migration 0009: `legal_hold` table (Slice C; per Q-OPEN-3 fold-in).
- Per-tenant Cloud Run TF module (no Cloud Run TF in repo today).
- Cloud Tasks queue + IAM (no Cloud Tasks TF in repo today). Three queues per Q-OPEN-1.
- `tenants.{provision, suspend, resume, offboard, terminate, rotateKeys}` lifecycle workflows.
- HTTP API surface (D3 + D8).
- 5 new audit actions (D6 hybrid).

---

## Acceptance criteria

Paraphrased from F02 spec:

1. **Standard tenant provisioning** completes end-to-end in **< 5 minutes** (no dedicated Cloud SQL).
2. **Enterprise tenant provisioning** completes end-to-end in **< 30 minutes**, including dedicated Cloud SQL allocation. (Note: per Q-OPEN-6, Enterprise provisioning gates on manual approval; the <30-min clock starts at approval, not at REQUESTED submission.)
3. **Rollback from any failed provisioning step** leaves zero orphaned resources (KMS key, GCS prefix, control-plane rows, Cloud Run service, dedicated Cloud SQL — all back to pre-state).
4. **Termination after grace period** deletes every tenant-scoped trace; post-termination queries (read by tenant id, by external_id) return `tenant-not-found` consistently.
5. **Idempotency:** re-running provisioning after partial failure resumes from the failure point without producing duplicate side effects (per D5: tenant_id-only dedup).
6. **Key rotation:** zero-downtime overlap window; in-flight encrypts/decrypts with the prior key continue to succeed during the rotation cutover.
7. **Legal hold:** if `tenant.legal_hold` is set on tenant data, termination is blocked; explicit Super Admin override workflow required to proceed.
8. **All lifecycle events emit audit-chain rows** (SCR-20 integration).

Commit shape: `feat(F02): tenant lifecycle manager` (per spec).

---

## Decisions (D1–D12 — all locked 2026-04-27)

### D1 — Slice structure: **4 slices**

- **Decision:** Slice A = provisioning + 3 stub swaps + §4.15/§4.16/§4.17 cleanup + ADR-LIFECYCLE-001 + convention doc + migration 0008. Slice B = suspension + resume + §10.15 contention test. Slice C = offboarding + termination + legal_hold (migration 0009) + per-env signing SA. Slice D = key rotation + HTTP API + Cloud Run TF + Cloud Run IAM authz.
- **Rationale:** Provisioning is already substantive (state machine + 3 stub swaps + 4 cleanup vectors); pairing with Slice A gives a coherent foundation. Key rotation has dual-key overlap logic that warrants its own surface; pairing with HTTP API in Slice D gives operators their first ad-hoc interface (rotation is the most common ops trigger). Suspension and termination are independently testable workflows.
- **Trade-off:** Slice A is heaviest (substrate + workflow + 4 cleanups). Slice D depends on Hono spike landing cleanly. 5-slice variant rejected: stub swaps are tightly coupled to provisioning's per-tenant key creation path, separating them creates artificial dependency.
- **Reference:** F01 Slice C precedent (3 slices for a smaller surface); F02 spec §1–§5 maps cleanly onto 4 slices.

### D2 — New ADR(s): **ADR-LIFECYCLE-001 only**

- **Decision:** Ship ADR-LIFECYCLE-001 covering state machine + Cloud Tasks orchestration + idempotency primitive. No ADR-LIFECYCLE-002.
- **Rationale:** State-machine + orchestration is architecturally load-bearing — defines how every lifecycle workflow runs. Idempotency primitive (D5: tenant_id-only) is a caller-facing convention, not architecture; belongs in `tenant-lifecycle-convention.md`.
- **Trade-off:** Single ADR mixes two concerns (state machine + orchestration). Acceptable: both are inseparable in practice — state transitions ARE Cloud Task triggers.
- **Reference:** Appendix A skeleton below; ADR-COMPUTE-001 precedent (single ADR covers Cloud Run service-per-tenant + workload naming).

### D3 — HTTP framework: **Hono with prod-readiness spike at start of Slice D**

- **Decision:** Adopt Hono. Slice D's first step is a spike: verify Cloud Run cold-start behavior, structured-logging integration with `@cortex/observability`, error-middleware composition. Fall back to Express only if a spike-finding blocks.
- **Rationale:** Hono is already the workspace's structural-adapter pattern (`@cortex/quotas`, `@cortex/tenant-context` middleware adapters). Cloud Run-friendly. Modern fetch-API native. Spike de-risks the first-runtime-consumer concern.
- **Trade-off:** Hono prod-readiness on Cloud Run is unverified (only structural mocks in workspace today). Spike adds 1–2 days to Slice D start; cheap insurance.
- **Reference:** `packages/quotas/test/middleware.spec.ts` (existing structural Hono pattern); roadmap §10.11 (forcing function).

### D4 — Async orchestration: **Cloud Tasks**

- **Decision:** Cloud Tasks for all lifecycle workflows. Three queues per Q-OPEN-1: `provisioning-queue`, `lifecycle-queue` (suspend/resume/offboard/terminate), `key-rotation-queue`.
- **Rationale:** Spec specifies it explicitly. Built-in retry + scheduled execution + per-task deduplication matches the "async pipeline with idempotent steps" shape of provisioning. GCP-native, no new infrastructure dep.
- **Trade-off:** Operational learning curve for Cloud Tasks (queue config, IAM, monitoring). One-time cost; pays back across all 5 capabilities.
- **Reference:** F02 spec §1 ("driven by Cloud Tasks"); roadmap §4.12 (Pub/Sub fan-out — different shape, kept distinct).

### D5 — Idempotency primitive: **tenant_id-only dedup**

- **Decision:** Cloud Tasks `taskId = '<verb>-<tenant_id>'` (e.g., `provisioning-{tenant_id}`, `termination-{tenant_id}`). One pending task per (verb, tenant). Convention doc §1 documents the retry pattern: "to retry a failed provisioning, the operator first manually cleans up partial state, then resubmits."
- **Rationale:** Phase 1 reality: 1 tenant. tenant-id dedup is sufficient; saga pattern would over-engineer for current scale. Cloud Tasks built-in dedup primitive matches the use case directly.
- **Trade-off:** "Manual cleanup before retry" is an operational pattern, not an automatic recovery. Acceptable at low tenant volume; F03+ may force the upgrade to a saga pattern when concurrent provisioning becomes load-bearing.
- **Reference:** Cloud Tasks Task ID dedup (GCP docs); convention doc §1 documents retry pattern; "Operational patterns" section below tracks this as ops attention.

### D6 — Audit catalog additions: **Hybrid (5 new actions)**

- **Decision:** Domain actions for irreversible/compliance-relevant transitions: `TENANT_PROVISIONED`, `TENANT_OFFBOARDING_STARTED`, `TENANT_TERMINATED`, `TENANT_KEY_ROTATED`, `TENANT_CONFIG_VERSION_UPDATED`. Continue using existing `TENANT_STATUS_CHANGED` (Slice A) for symmetric reversibles (SUSPEND ↔ RESUME).
- **Rationale:** Compliance regulators care about provisioning-completed, offboarding-started, terminated, and key-rotated as distinct grep-able events. Symmetric transitions (suspend/resume) are operational, not compliance-critical, and the before/after_state on `TENANT_STATUS_CHANGED` already captures the delta.
- **Trade-off:** 5 new actions add catalog surface; readers querying "all lifecycle events for tenant X" must union 6 action names. Mitigated by the resource field (`tenant:{id}`) being grep-able across all of them.
- **Reference:** ADR-AU-001 §Decision 3 (verb diversity for compliance); `packages/tenant-context/src/audit-actions.ts` (existing 5 actions).

### D7 — Migration 0008 scope: **Status enum extension + lifecycle metadata**

- **Decision:** Migration 0008 in Slice A:
  1. Extend `tenant.status` CHECK to add `REQUESTED`, `READY`, `OFFBOARDING` (3 new values; existing 4 retained).
  2. Add columns: `tenant.last_key_rotated_at timestamptz`, `tenant.terminated_at timestamptz`, `tenant.offboarding_grace_until timestamptz`, `tenant.legal_hold boolean NOT NULL DEFAULT false`, `tenant.dedicated_db_approved boolean NOT NULL DEFAULT false`.

  Migration 0009 in Slice C ships the `legal_hold` table for upgrade path to richer hold semantics (the `tenant.legal_hold` boolean is the Phase 1 single-flag form; the table is the Phase 2 expansion target — see Q-OPEN-3 fold-in).

- **Rationale:** Lifecycle queries unblock immediately ("tenants overdue for rotation" / "tenants with pending termination"). `legal_hold` boolean inline supports the Phase 1 use case without forcing a join. `dedicated_db_approved` gates Enterprise provisioning per Q-OPEN-6 manual approval.
- **Trade-off:** Two columns (`legal_hold` + future `legal_hold` table) coexist briefly. Phase 2 migration can fold one into the other; documenting the intent in convention doc §6.
- **Reference:** Migration 0007 column conventions (`date_trunc('millisecond', now())` defaults, NOT NULL discipline); Q-OPEN-3 fold-in (single flag now, table for future granularity); Q-OPEN-6 fold-in (manual approval gate).

### D8 — Tenant CRUD authz interim: **Cloud Run service-to-service IAM**

- **Decision:** F02 HTTP endpoints are private Cloud Run services; only callable by SCR-24 / W01 service accounts via Cloud Run invoker IAM. Per-method authz layered later by AC01.
- **Rationale:** Cloud Run IAM is the cleanest interim — already a workspace pattern (per ADR-INFRA-006 WIF identity layer); zero new code at the auth layer; AC01 layers per-method authz on top when it ships. Service-token alternative would add a rotation/secret-management problem AC01 obsoletes anyway.
- **Trade-off:** "Trust the caller's SA" model has no method-level granularity until AC01. Acceptable: the only callers in Phase 1 are platform internals (SCR-24, W01). External-facing per-tenant authz is AC01's job.
- **Reference:** ADR-INFRA-006 (WIF identity layer); roadmap §10.12 (forcing function).

### D9 — Workspaces position: **Defer to AC02**

- **Decision:** F02 ships at tenant level only. No workspace substrate, no workspace lifecycle, no workspace authz. Spec text mentioning workspaces ("per F02") superseded by AC02 ownership.
- **Rationale:** Workspace substrate (table, FK shape, RLS posture, hierarchy semantics — see roadmap §10.10) requires AC02's ABAC model as design input. Forcing F02 to ship workspaces without that input would lock in a shape AC02 has to either inherit or refactor; both options are worse than deferring.
- **Trade-off:** Spec drift — F02 spec mentions workspaces. Captured as Drift 6 (new); the spec text is incorrect about ownership. Documented in convention doc §10.
- **Reference:** Roadmap §10.10 (forcing function); AC02 build prompt P2.2 (TBD; AC02 owns hierarchy + workspace).

### D10 — TF module shape: **Generic `tenant-cloud-run-service` parameterized by workload**

- **Decision:** One TF module, `infra/terraform/modules/tenant-cloud-run-service/`, parameterized by `(workload, tenant_id, env)`. Apps invoke per-workload with `var.workload = "api-gateway"` etc. Workload-specific extras (vector DB, GPU) wrap the module in a workload-specific module.
- **Rationale:** Aligns with `{workload}-tenant-{uuid}` naming convention from ADR-COMPUTE-001 §3. Reduces TF module proliferation; per-workload variation lives in `var.workload` + `var.image_uri`, not a forked module. F02 ships only the baseline shape; workload-specific extension is downstream's concern.
- **Trade-off:** Generic module assumes baseline Cloud Run config fits all workloads. May not — first workload needing custom GPU/secret-volume mounts will need a wrapper. Acceptable: wrapper > fork.
- **Reference:** ADR-COMPUTE-001 §3 (service-name format); existing TF module precedent (`infra/terraform/modules/tenant-data-bucket/`).

### D11 — Swap-paths doc retirement: **Roll into `tenant-lifecycle-convention.md` as appendix**

- **Decision:** When Slice A ships all three swaps, retire `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md`; preserve its content as an appendix in the new `tenant-lifecycle-convention.md`. Update all references (ADR-COMPUTE-001 §5, quotas-compute-placement-convention.md, slice C planning doc) to point at the new appendix location.
- **Rationale:** Preserves the swap-path contract narrative for future readers — the substrate-now / real-impl-later pattern is a reusable lesson worth keeping. Convention doc is the natural home; standalone doc would orphan as Slice C → F02 contract becomes historical.
- **Trade-off:** Convention doc grows by ~200 lines. Acceptable: a single canonical location is operationally simpler than split docs.
- **Reference:** Roadmap §4.17 (cleanup vector); Appendix B skeleton below.

### D12 — Time horizon: **Open-ended at slice level**

- **Decision:** No fixed deadline. Estimate: 4–5 sub-slices per slice; commit when each lands. Continue F01's per-slice cadence.
- **Rationale:** F02's surface is materially larger than any F01 slice — first per-tenant TF, first Cloud Tasks, first HTTP API, first key rotation. Solo-dev pace is unpredictable on first-time-substrate work. Slice-by-slice estimation per sub-phase lock works better than a fixed deadline.
- **Trade-off:** No external deadline pressure; risk of scope creep. Mitigation: each sub-phase has a HOLD review gate (precedent from F01 Slice C + this CI fix).
- **Reference:** F01 Slice C precedent (open-ended; shipped in 1 working day).

---

## Spec drifts handled

### Drift 1 — "K8s namespace per Enterprise tenant" → Cloud Run

F02 spec §3 (Termination) lists "tenant K8s namespace" deletion. ADR-COMPUTE-001 (Slice C) supersedes. F02 termination workflow deletes the per-tenant Cloud Run service(s) instead. Captured in convention doc §7 as Spec deviation 1.

### Drift 2 — `tenant.status` CHECK enum extension

F02 spec adds `REQUESTED`, `READY`, `OFFBOARDING` states. Migration 0008 (Slice A) extends `tenant.status` CHECK to cover all 7 values. The `ACTIVE` vs `READY` distinction (`READY` = "provisioning done"; `ACTIVE` = "tenant is live and serving traffic") spec'd in convention doc §1.

### Drift 3 — AC01 session revoke (suspension cascade)

Resolved by Q-OPEN-2 fold-in. F02 emits `TENANT_SUSPENDED` audit event; AC01 subscribes when shipped. F02 does not call AC01 directly. Convention doc §5 documents the event-sourcing pattern.

### Drift 4 — S15 device pause / S17 outbound stop (suspension cascade)

Same shape as Drift 3. F02 emits `TENANT_SUSPENDED` event; downstream cascades land when those modules consume the event later. F02 does NOT block suspension on these cascades.

### Drift 5 — `tenant-scoped migrations` in provisioning

F02 spec §1 (Provisioning) lists "run tenant-scoped migrations." Phase 1 has shared DB with RLS; tenant-scoped migrations only apply to Enterprise dedicated DB path. STUB-or-defer for Standard tenants. Slice A documents the gap; first Enterprise tenant lands the dedicated-DB migration runner.

### Drift 6 — Workspaces ("per F02") → AC02

Per D9 lock. F02 spec mentions workspaces; correct ownership is AC02. Convention doc §10 captures the shift; spec deviation tracker updated.

---

## Forcing functions (§10 items F02 hits)

| §10 item                                  | F02 position                                                                                                         | Slice   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| **§10.4** DB client abstraction shape     | F02 ships `getTenantDbClient(tenantId)` factory; tier-aware routing (only shared path exercised in Phase 1)          | Slice A |
| **§10.8** Pre-signed URL signing identity | Per-env `cortex-export-signer-{env}` SA, NOT per-tenant. Per-tenant SA is over-fragmented for export-only operations | Slice C |
| **§10.10** Workspaces vs hierarchies      | Defer to AC02 (D9)                                                                                                   | N/A     |
| **§10.11** HTTP framework                 | Hono with prod-readiness spike at Slice D start (D3)                                                                 | Slice D |
| **§10.12** Tenant CRUD authz              | Cloud Run service-to-service IAM (D8)                                                                                | Slice D |
| **§10.15** FOR UPDATE contention test     | Ship alongside Slice B's suspend/resume (most contention-prone surface)                                              | Slice B |

---

## Cleanup vectors (§4 items F02 inherits or resolves)

| §4 item                                                               | F02 action                                                                                                                                                                                                                    | Slice                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **§4.13** Cycle decoupling                                            | RESOLVED 2026-04-27 / `ebb14ca`. F02 inherits clean topology. No action.                                                                                                                                                      | N/A (already resolved)         |
| **§4.14** AC01 actor swap (encryption)                                | F02 reproduces the pattern. Hardcodes `actorType='service'`, `actorId='cortex-tenant-lifecycle'` for its emissions. AC01 swaps both `cortex-encryption` and `cortex-tenant-lifecycle` to request-scoped actors when it ships. | Slice A (catalog registration) |
| **§4.15** Redundant `getKeyForTenant` consult in `@cortex/encryption` | Resolve alongside Slice A's getKeyForTenant swap. Merge encryption library's lookup paths. `envelope.encrypt` accepts a pre-resolved `keyResourceName`; `@cortex/encryption` resolves once and threads it through.            | Slice A                        |
| **§4.16** Dead logger plumbing in `@cortex/quotas`                    | Delete in Slice A. Cycle-defensive justification gone (resolved §4.13); no real WARN-level emit site exists; clean removal.                                                                                                   | Slice A                        |
| **§4.17** Swap-paths doc retirement                                   | Roll into `tenant-lifecycle-convention.md` per D11.                                                                                                                                                                           | Slice A                        |

---

## Slice-by-slice plan (locked 4-slice structure)

### Slice A — Provisioning + 3 stub swaps + cleanup vectors

**Scope.** Establishes the full F02 substrate. Provisioning workflow with state machine (REQUESTED → PROVISIONING → READY) backed by Cloud Tasks; three Phase 1 resolver stubs swapped to real implementations; four cleanup vectors resolved (§4.15 / §4.16 / §4.17 + AC01-actor-pattern reproduction §4.14); migration 0008 lands the status enum extension + 5 lifecycle metadata columns; ADR-LIFECYCLE-001 + `tenant-lifecycle-convention.md` document the architecture.

**Provisioning workflow specifics (Q-OPEN folded in):**

- **Cloud Tasks queue config (Q-OPEN-1):** `provisioning-queue` with exponential backoff (Cloud Tasks default 30s → 5min → 30min cap), max 5 attempts, concurrency cap of 10 per queue (each provisioning is 5–30 min; >10 risks DB connection exhaustion). `taskId = 'provisioning-{tenant_id}'` for built-in dedup.
- **IC01 vertical-package seed (Q-OPEN-4):** Provisioning seeds `tenant_config_version` v=1 with empty `config_json: {}`. IC01 (P5.2) swaps to vertical-package seed when shipped. Hardcoding Display Data's vertical seed rejected: couples F02 to a specific tenant.
- **Initial admin invite (Q-OPEN-5):** Provisioning emits `TENANT_PROVISIONED` audit event with tenant metadata; W01 (when shipped) consumes for invite. F02 does not block on W01 or WorkOS.
- **Enterprise Cloud SQL manual approval gate (Q-OPEN-6):** Provisioning for `tier='ENTERPRISE'` creates the `tenant` row with `status='REQUESTED'` and waits. An admin marks `tenant.dedicated_db_approved=true` via the control plane (HTTP API in Slice D; for Slice A, direct DB update by a Sevyn8 operator). Provisioning continues from REQUESTED → PROVISIONING → READY only after approval. Cost rationale: each Cloud SQL instance is $50–200/month; auto-provisioning on every Enterprise signup is operationally risky at low volume. Convention doc §9 documents the pattern + upgrade path (when Enterprise volume hits ~10/month, automate).

**Three stub swaps:**

- `getKeyForTenant(tenantId)` in `@cortex/secrets` queries `tenant_kms_key` (table already populated by Slice B's `tenants.create`). Resolves swap-paths doc Resolver 3 (the third stub the doc didn't catalog explicitly).
- `getQuotaConfig(tier, resourceClass, ctx?)` in `@cortex/quotas` becomes async; consults `tenant_config_version.config_json.quotas[resource_class]` with fallback to `DEFAULT_TIER_QUOTAS`. Resolves swap-paths doc Resolver 1.
- `getComputePlacement(params)` in `@cortex/compute-placement` branches on `tenant.tier`; returns `{kind: 'dedicated', cloudRunService: '${workload}-tenant-${uuid}', placementLabel: 'dedicated'}` for ENTERPRISE. Resolves swap-paths doc Resolver 2.

**Cleanup vectors:**

- §4.14 reproduced (hardcoded `actorId='cortex-tenant-lifecycle'`; AC01 swaps later).
- §4.15 resolved (encryption library lookup paths merged).
- §4.16 resolved (dead logger plumbing removed from `@cortex/quotas`).
- §4.17 resolved (swap-paths doc rolled into convention doc Appendix).

**Forcing functions resolved:** §10.4 (`getTenantDbClient` factory).

**Deliverables:**

- `@cortex/tenant-context` adds `tenants.provision(input, ctx)` workflow.
- `packages/secrets/src/per-tenant-keys.ts:getKeyForTenant` swapped.
- `packages/quotas/src/config.ts:getQuotaConfig` swapped + signature change.
- `packages/compute-placement/src/get-placement.ts:getComputePlacement` swapped.
- `packages/encryption/src/encrypt.ts` lookup-path merge (§4.15).
- `packages/quotas/src/check-quota.ts` logger plumbing removed (§4.16).
- 5 new audit actions registered: `TENANT_PROVISIONED`, `TENANT_OFFBOARDING_STARTED`, `TENANT_TERMINATED`, `TENANT_KEY_ROTATED`, `TENANT_CONFIG_VERSION_UPDATED` (later slices use the catalog).
- Migration 0008.
- ADR-LIFECYCLE-001 (new).
- `docs/architecture/tenant-lifecycle-convention.md` (new; absorbs swap-paths doc).
- TF: Cloud Tasks queue (`provisioning-queue`) + IAM bindings.
- Tests: provisioning end-to-end with rollback simulation; manual approval gate; stub-swap behavior tests; getTenantDbClient factory tests.

**Effort estimate:** Heaviest slice. ~5–7 sub-phases (substrate / workflow / 3 swaps / cleanup vectors / convention doc / ADR). 1 sub-slice cadence per F01 precedent — likely 1–2 working days at solo-dev pace.

### Slice B — Suspension + Resume

**Scope.** Suspension and resume workflows. Status flips + audit emissions + cascade events. AC01 session revoke is push-style (Q-OPEN-2): F02 emits `TENANT_SUSPENDED` audit event; AC01 subscribes when shipped. Same shape for S15 device pause + S17 outbound stop. F02 does not block on any downstream consumer.

**Suspension workflow specifics (Q-OPEN folded in):**

- **AC01 session revoke (Q-OPEN-2):** Push-style event sourcing. F02's `tenants.suspend` emits `TENANT_SUSPENDED` audit event with full tenant metadata; AC01 (when shipped) subscribes and revokes sessions on emission. F02 does not call AC01 directly. Clean event-sourcing pattern; same shape for S15/S17 cascades. Convention doc §5 captures the contract.

**Forcing functions resolved:** §10.15 (FOR UPDATE contention test). Lifecycle workflows lean heavily on `setStatus` / `update` locks; suspend/resume is the most concurrency-prone surface (operator hits "suspend" while a background job is mid-update).

**Deliverables:**

- `tenants.suspend(tenantId, reason, ctx)` — flips status to SUSPENDED; emits `TENANT_SUSPENDED` audit event with reason + cascade-event metadata.
- `tenants.resume(tenantId, ctx)` — SUSPENDED → ACTIVE transition; emits `TENANT_STATUS_CHANGED` per D6 hybrid (symmetric reversible).
- TF: `lifecycle-queue` Cloud Tasks queue (covers suspend/resume/offboard/terminate per D4 Q-OPEN-1).
- Tests: suspend → resume → suspend cycles; concurrent suspend attempts; cascade emission; FOR UPDATE contention test.

**Effort estimate:** Lightest slice. ~2–3 sub-phases (workflow / contention test / convention doc updates).

### Slice C — Offboarding + Termination

**Scope.** Offboarding workflow (export archive + grace period); termination workflow (hard delete + KMS tombstone); legal-hold guards (Q-OPEN-3). Migration 0009 ships the `legal_hold` table for upgrade path to richer hold semantics.

**Offboarding/Termination specifics (Q-OPEN folded in):**

- **Legal-hold scope (Q-OPEN-3):** Per-tenant initially. `tenant.legal_hold boolean` (in migration 0008) is the Phase 1 flag; `legal_hold` table (migration 0009) is the upgrade path. Termination queries `tenant.legal_hold` (and the table once it exists); termination is blocked if any hold is active. Per-record (data-class scope) holds deferred; revisit when first compliance use case requires granular. Convention doc §6 documents upgrade path.
- **Pre-signed URL signing identity (Q-OPEN-§10.8 fold-in):** Per-env `cortex-export-signer-{env}` SA. F02 export-archive flow uses this SA to sign. Per-tenant SA over-fragmented for export-only operations; per-env signer gates by IAM on the call site.

**Forcing functions resolved:** §10.8 (per-env signing SA).

**Deliverables:**

- `tenants.offboard(tenantId, ctx)` — flips status to OFFBOARDING; generates signed-URL export archive (30-day TTL); schedules termination Cloud Task at `now() + grace_period` (default 30 days).
- `tenants.terminate(tenantId, ctx)` — hard delete: tenant Cloud Run service(s) → tenant GCS prefix → tenant Cloud SQL instance (Enterprise) → shared-DB tenant rows → KMS key tombstone.
- Legal-hold workflow: `legal_hold` table; `tenants.terminate` queries before destruction; Super Admin override RPC.
- Migration 0009 (legal_hold table).
- TF: `cortex-export-signer-{env}` SA + IAM bindings.
- Tests: offboarding workflow; termination idempotency; legal-hold blocking; post-termination "tenant not found" assertion.

**Effort estimate:** Mid-weight. ~3–4 sub-phases (workflow / legal-hold / signing SA / convention doc updates).

### Slice D — Key rotation + HTTP API + Cloud Run TF

**Scope.** Key rotation workflow with dual-key overlap (90-day default + on-demand). HTTP API for all 6 lifecycle workflows (provision / suspend / resume / offboard / terminate / rotateKeys). Per-tenant Cloud Run TF module (D10). Cloud Run service-to-service IAM authz (D8).

**HTTP framework spike (D3):**

- Slice D's first sub-phase is a Hono prod-readiness spike: verify Cloud Run cold-start behavior, structured-logging integration with `@cortex/observability`, error-middleware composition. If a spike-finding blocks, fall back to Express (existing structural adapters in `@cortex/quotas` + `@cortex/tenant-context`). Decision committed before HTTP API implementation begins.

**Forcing functions resolved:** §10.11 (HTTP framework — Hono via spike); §10.12 (Cloud Run service-to-service IAM authz).

**Deliverables:**

- `tenants.rotateKeys(tenantId, ctx)` — 90-day default + on-demand; dual-key overlap window; updates `tenant_kms_key.kms_key_resource_name` + `tenant.last_key_rotated_at`.
- HTTP API (Hono per spike) for all 6 lifecycle workflows.
- TF: `infra/terraform/modules/tenant-cloud-run-service/` (generic, parameterized by workload).
- TF: `key-rotation-queue` Cloud Tasks queue.
- Tests: key-rotation overlap window; HTTP integration tests; auth-gating tests; end-to-end provisioning via HTTP (matches Acceptance criteria 1+2).

**Effort estimate:** Mid-heavy. ~4–5 sub-phases (Hono spike / key rotation workflow / HTTP API / TF module / IAM authz). Spike adds 1–2 days at slice start.

---

## Operational patterns introduced by F02

These patterns require ongoing ops attention; documented in `tenant-lifecycle-convention.md` §9.

### 1. Manual approval workflow for Enterprise dedicated DB (Q-OPEN-6)

Enterprise provisioning gates on `tenant.dedicated_db_approved=true`. An operator must manually approve before Cloud SQL spin-up. Phase 1 Approval pattern: direct DB update by Sevyn8 operator. Slice D introduces an HTTP API endpoint for the approval action.

**Upgrade trigger:** Enterprise volume ≥ ~10/month → automate the approval gate (cost-policy validation, signature-based approval, etc.). Track on roadmap.

### 2. Retry pattern for failed provisioning (D5)

tenant_id-only dedup means a failed provisioning blocks resubmission for the same `tenant_id` until the existing task entry expires from Cloud Tasks. Operational pattern: operator manually cleans up partial state (delete tenant row if status=PROVISIONING with no progress; clean up partial Cloud Run service if created), then resubmits.

**Upgrade trigger:** Multi-tenant scale (concurrent provisioning) → saga pattern with persistent state machine. Track on roadmap as F03+ concern.

### 3. Legal-hold flag management (Q-OPEN-3)

`tenant.legal_hold boolean` in Phase 1; `legal_hold` table in Slice C. Legal hold blocks termination. Operator workflow: legal team requests hold → engineering sets `tenant.legal_hold=true` (Slice C: insert into `legal_hold` table with reason + set_by_user_id) → termination blocked until hold released.

**Upgrade trigger:** Per-record (data-class scope) hold needed → expand `legal_hold` table to support data-class scope. Track on roadmap as compliance concern.

### 4. W01 admin-invite event consumer (Q-OPEN-5; future)

F02 emits `TENANT_PROVISIONED` audit event on provisioning success. W01 (Tenant Onboarding Wizard) is the intended consumer — reads the event, creates the initial admin invite via WorkOS. F02 does not block on W01.

**Tracking:** Roadmap entry for W01 to subscribe to `TENANT_PROVISIONED` events when W01 ships.

### 5. AC01 session-revoke event consumer (Q-OPEN-2; future)

F02 emits `TENANT_SUSPENDED` audit event on suspension. AC01 (P2.1) is the intended consumer — reads the event, revokes active sessions for the tenant. F02 does not call AC01 directly.

**Tracking:** Roadmap entry for AC01 to subscribe to `TENANT_SUSPENDED` events when AC01 ships. Same pattern applies to S15 device pause + S17 outbound stop cascades.

---

## References

- **Build prompt:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.2 (lines 997–1050).
- **Spec:** Cortex v2.2 Spec §F02 (binary `.docx`; in-repo at `docs/spec/cortex_v2.2.docx`).
- **Existing ADRs:**
  - ADR-COMPUTE-001 (Cloud Run service-per-tenant for Enterprise; Drift 1).
  - ADR-INFRA-007 (per-tenant CMEK substrate; precedent for per-tenant key swap).
  - ADR-AU-001 (audit emission library; D6 verb diversity).
  - ADR-DB-002 (RLS baseline; tenant_kms_key + tenant_config_version policies).
  - ADR-INFRA-006 (WIF identity layer; D8 Cloud Run IAM).
- **F02-produced artifacts:**
  - **ADR-LIFECYCLE-001** (state machine + Cloud Tasks orchestration; lands Slice A — Appendix A skeleton below).
  - **`docs/architecture/tenant-lifecycle-convention.md`** (lands Slice A; absorbs swap-paths doc per D11 — Appendix B skeleton below).
  - **Migration 0008** (Slice A): status enum extension + 5 lifecycle metadata columns (`last_key_rotated_at`, `terminated_at`, `offboarding_grace_until`, `legal_hold`, `dedicated_db_approved`).
  - **Migration 0009** (Slice C): `legal_hold` table.
  - **`infra/terraform/modules/tenant-cloud-run-service/`** (Slice D): generic per-tenant Cloud Run TF module.
- **Companion docs (existing):**
  - `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md` (D11 retirement target).
  - `docs/architecture/quotas-compute-placement-convention.md` (Slice C consumer contract).
  - `docs/architecture/encryption-blob-storage-convention.md` (§4.14, §4.15 patterns).
  - `docs/architecture/audit-event-convention.md` (D6 catalog ownership rule).
- **Roadmap entries:** §10.4, §10.8, §10.10, §10.11, §10.12, §10.15 (open §10 forcing functions); §1.1 (per-tenant CMEK trigger criteria); §4.14, §4.15, §4.16, §4.17 (cleanup vectors); §4.13 (RESOLVED — clean topology inherited).
- **Slice C precedent:** `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md` (planning doc structure + decision template).
- **Substrate code:** `services/foundation/migrations/0007_control_plane_tables.sql` (tenant + tenant_kms_key + tenant_config_version + tenant_quota_usage); `packages/tenant-context/src/tenants.ts` (existing CRUD); `packages/secrets/src/per-tenant-keys.ts` (getKeyForTenant Phase 1 stub).

---

## Appendix A — ADR-LIFECYCLE-001 skeleton

To be expanded into a full ADR at Slice A implementation. Produced as `docs/architecture/decisions/ADR-LIFECYCLE-001-state-machine-and-cloud-tasks.md`.

**Status:** Proposed at scoping; Accepted at Slice A ship.

**Context.** Why F02 needs an explicit state machine + async orchestration layer:

- Provisioning takes 5–30 minutes (Standard vs Enterprise); synchronous HTTP is impossible.
- Multiple lifecycle stages (provisioning, suspension, offboarding, termination, key rotation) share a state model.
- Operators need observable progress through long workflows.
- Idempotency requires explicit retry semantics tied to a state machine.
- Spec (F02 §1) explicitly calls for Cloud Tasks.

**Decision.**

- **State machine:** REQUESTED → PROVISIONING → READY → ACTIVE → SUSPENDED → ACTIVE → OFFBOARDING → TERMINATED. Transitions table specifies allowed transitions per state (exhaustive; rejected transitions raise `TenantStatusError`).
- **State storage:** `tenant.status` column with extended CHECK constraint (per migration 0008).
- **Async orchestration:** Cloud Tasks. Three queues: `provisioning-queue`, `lifecycle-queue` (suspend/resume/offboard/terminate), `key-rotation-queue`. Each queue has dedicated retry config + concurrency cap.
- **Idempotency:** Cloud Tasks `taskId = '<verb>-<tenant_id>'` for built-in dedup. Convention doc §1 documents the manual-cleanup-then-retry operational pattern.

**Consequences.**

- F02 ships state-transition library; future lifecycle stages add transitions to the table without code changes elsewhere.
- Cloud Tasks operational learning curve (queue config, IAM, monitoring); one-time cost.
- Manual-cleanup-on-failure operational pattern is acceptable at low tenant volume; saga pattern is the upgrade path.
- Per-tenant taskId dedup means failed provisioning blocks the tenant_id slot until the task entry expires.

**Alternatives considered.**

- **Synchronous HTTP** — rejected: 5–30 min provisioning would tie up Cloud Run instance; no progress visibility.
- **Cloud Run Jobs** — rejected: not interrupt-driven; no built-in retry; no scheduled execution.
- **Pub/Sub** — rejected: fan-out semantics (multiple subscribers) are wrong for single-consumer workflow.
- **Saga pattern** — deferred: over-engineered for Phase 1 (1 tenant); F03+ may force the upgrade.

**References.**

- F02 spec (build prompts §P1.2).
- ADR-COMPUTE-001 (Cloud Run service-per-tenant; provisioning creates these).
- ADR-INFRA-007 (per-tenant CMEK; provisioning populates `tenant_kms_key`).
- Migration 0008 (status enum extension).
- `tenant-lifecycle-convention.md` §1, §2 (state machine + queue config).

---

## Appendix B — `tenant-lifecycle-convention.md` skeleton

To be expanded into a full convention doc at Slice A implementation. Produced as `docs/architecture/tenant-lifecycle-convention.md`.

**Sections:**

- **§1 State machine** — allowed transitions table; transition triggers; idempotency primitive (per D5); manual-cleanup-then-retry operational pattern.
- **§2 Cloud Tasks orchestration** — three queues (per Q-OPEN-1); queue config (retry, backoff, concurrency); taskId dedup pattern; queue-IAM model.
- **§3 Audit emission patterns** — hybrid catalog (per D6); domain actions for irreversible/compliance events; `TENANT_STATUS_CHANGED` for symmetric reversibles; before/after_state conventions.
- **§4 Provisioning workflow** — Standard vs Enterprise paths; manual approval gate for Enterprise (per Q-OPEN-6); IC01 vertical-package seed (Phase 1 stub per Q-OPEN-4); admin-invite event emission (per Q-OPEN-5); rollback semantics.
- **§5 Suspension cascade** — `TENANT_SUSPENDED` event emission; AC01 session-revoke (push-style; Q-OPEN-2); S15 + S17 future consumer contracts.
- **§6 Offboarding workflow** — export archive + grace period; pre-signed URL signing identity (per-env signer SA, §10.8); legal-hold flag (Q-OPEN-3) Phase 1 single-flag; legal_hold table upgrade path (Phase 2).
- **§7 Termination workflow** — hard delete sequence; KMS key tombstone; idempotency; spec deviation 1 (K8s namespace → Cloud Run service per ADR-COMPUTE-001).
- **§8 Key rotation** — 90-day cadence; dual-key overlap window; on-demand triggering.
- **§9 Operational patterns** — retry-after-cleanup; manual approval; legal-hold management; failed-provisioning recovery.
- **§10 Future swaps** — IC01 vertical seed (P5.2 swap); W01 admin invite (W01 ship); AC01 session revoke (P2.1 swap); per-record legal hold (compliance trigger); auto-Cloud-SQL approval (volume trigger); spec deviation 6 (workspaces → AC02).
- **Appendix A** — F02 swap-paths (rolled in from `f02-swap-paths-for-slice-c-resolvers.md` per D11/§4.17). Three resolvers: `getKeyForTenant`, `getQuotaConfig`, `getComputePlacement` — historical contract from Slice B/C → F02. Marked as resolved when Slice A ships the swaps.

---

**Decision lock complete.** Sub-phase 3 begins Slice A implementation.

# F02 Slice D — Key rotation + HTTP API + Cloud Run TF + IAM authz

**Status:** Scoped 2026-04-29; SD-decisions locked 2026-04-29; sub-phase plan below.
**Primary sources:** Cortex v2.2 Spec §F02 (key rotation acceptance: "zero-downtime overlap window"); `docs/build-prompts/cortex_build_prompts_v3.md` §P1.2 (lines 997–1050); `docs/planning/f02-tenant-lifecycle-scope.md` D1–D12 (locked 2026-04-27); `docs/spikes/2026-04-28-hono-prod-readiness.md`; `docs/architecture/decisions/ADR-HTTP-001-hono-as-http-framework.md` (the 6 binding conditions).
**Companion ADRs (existing):** ADR-HTTP-001 (Hono framework + 6 conditions); ADR-LIFECYCLE-001 (state machine + Cloud Tasks orchestration — substrate Slice D extends with `key-rotation-queue`); ADR-COMPUTE-001 (Cloud Run service-name format `{workload}-shared` / `{workload}-tenant-{uuid}` — D10 inherits); ADR-INFRA-006 (WIF identity layer — D8 invoker IAM inherits); ADR-INFRA-007 (per-tenant CMEK substrate — key rotation operates over this).
**Companion artifacts (Slice D produces):**

- `tenants.rotateKeys(db, tenantId, ctx)` — library workflow (D.2).
- HTTP API surface (D.3) — 12 endpoints over `apps/tenant-lifecycle-api/`.
- `infra/terraform/modules/tenant-cloud-run-service/` (D.4) — generic per-tenant Cloud Run TF module.
- `key-rotation-queue` Cloud Tasks queue + per-env wiring (D.4).
- IAM authz — Cloud Run invoker IAM with `--no-allow-unauthenticated` (D.5).
- Convention `tenant-lifecycle-convention.md` §7 expansion (D.6).
- New ADR(s): defer ADR-HTTP-002 (route conventions) unless D.3 surfaces a need; expected NOT needed.

---

## Context

F02 Slice D is the operator-facing surface — the four prior slices shipped substrate (provisioning + suspension + offboarding + termination + force-terminate + legal-hold helpers + cloud-tasks queues + signer SA), all reachable today only via direct package imports. Slice D layers HTTP routing, key rotation as the final lifecycle workflow, the per-tenant Cloud Run TF module that Slice A/B/C anticipated but didn't ship (per D10 lock), and the Cloud Run invoker IAM gate that D8 fixed as the Phase 1 authz floor. D.0 (the Hono prod-readiness spike, `cd285d6`) and D.0.5 (ADR-HTTP-001 codifying the spike's GO recommendation as 6 binding conditions, `a685294`) are complete. D.1's prototype must measure cold-start p95 and verify graceful SIGTERM before D.2+ begins on `main` — Conditions 2 + 3 of ADR-HTTP-001 are gates, not nice-to-haves.

---

## Acceptance criteria

Paraphrased from F02 spec §"Key rotation" + ADR-HTTP-001 + the F02 planning-doc Acceptance section:

1. **Cold-start (ADR-HTTP-001 Condition 2):** D.1 prototype reports p95 cold-start ≤ **500 ms** in real Cloud Run dev conditions, after scale-to-zero. Measurement methodology per SD3.
2. **Graceful SIGTERM (ADR-HTTP-001 Condition 3):** D.1 prototype demonstrates SIGTERM-to-clean-exit within Cloud Run's **10-second grace window**, with in-flight requests completing 2xx. Three sequential test deploys must pass.
3. **Key rotation overlap:** in-flight encrypts/decrypts succeed during rotation cutover. The application-layer mechanism (envelope encryption with `keyResourceName` recorded per payload, per `@cortex/encryption` Slice B + §4.15 cleanup) makes this functionally infinite at the encrypt/decrypt path; SD6 locks the KMS-side old-key destruction delay.
4. **HTTP API surface complete:** all 12 endpoints (9 mutating + 2 read + 1 Enterprise-approval per Q-OPEN-6) round-trip end-to-end with workspace-extended RFC 9457 problem-details envelope on errors per ADR-HTTP-001 Condition 5.
5. **Per-tenant Cloud Run TF:** `tenant-cloud-run-service` module instantiates a Cloud Run service matching ADR-COMPUTE-001's naming (`{workload}-tenant-{uuid}`); env-level wiring per SD9.
6. **Invoker IAM:** Cloud Run service deployed with `--no-allow-unauthenticated`; integration test verifies unauth requests get 403; authenticated test SA receives 2xx.
7. **End-to-end provisioning via HTTP:** Spec acceptance criterion 1 ("Standard tenant provisioning end-to-end in under 5 minutes") demonstrable through the HTTP API — replaces the direct-call test path.

**Reopen-ADR rule (binding):**

- Condition 2 fails (p95 > 500 ms): **reopen ADR-HTTP-001.** Diagnose source (Hono / `pg` pool warmup / `@google-cloud/*` SDK init / cold container) before deciding framework re-evaluation. Per ADR-HTTP-001 Verification: "diagnose before deciding whether the framework choice or the architecture is at fault."
- Condition 3 fails (SIGTERM > 10 s clean exit, or in-flight 503): **reopen ADR-HTTP-001.** Fallback path documented in ADR Condition 3 (vanilla `node:http` server with Hono via `app.fetch(req)`).
- Acceptance 4 partially failing (one or two endpoints fail validation but rest work): **Slice-D-internal mitigation** — fix per-endpoint; do not reopen ADR.
- Acceptance 5 / 6 partially failing: Slice-D-internal mitigation.

---

## SD# decisions (locked)

### SD1 — Sub-phase structure: 6 sub-phases (D.1 → D.6)

- **Decision:** D.1 prototype gate / D.2 key rotation workflow / D.3 HTTP API / D.4 TF module + key-rotation-queue / D.5 IAM authz / D.6 convention §7 + Slice D close.
- **Rationale:** D.1 must precede D.2+ per ADR-HTTP-001 (Conditions 2+3 gate). Key rotation (D.2) is independent of HTTP API (D.3) and would land cleanly in either order, but D.2 first means the HTTP API has a complete library-layer surface to expose by D.3 — no half-finished-workflow rework. TF (D.4) is naturally last among the implementation-heavy sub-phases since it consumes the runtime SA + queue config that D.2 + D.3 need first; key-rotation-queue lands here rather than D.2 because Slice C's Q-NEW-C1 lock proved env-level Cloud Tasks queue instantiation is its own discrete step. IAM (D.5) is mechanically small but logically distinct from D.4 — separating prevents IAM drift from co-evolving silently with TF module structure. D.6 is the close commit + convention §7 expansion (parallels Slice C 7.7).
- **Trade-off:** 6 sub-phases is one more than F02 planning's "4-5" estimate. The +1 covers: (a) D.1's pass/fail gate adds non-trivial measurement + cleanup work that conflated with D.2 would muddy the gate signal; (b) D.4's TF + queue work at slice-end is heavier than Slice C's TF sub-phase (which only added env wiring; Slice D adds a new TF module). Acceptable.
- **Reference:** Slice C precedent (7 sub-phases including 7.1 audit). F01 Slice C planning ran 10 sub-phases (smaller-step granularity). 6 is in range.

### SD2 — D.1 deployment path: real Cloud Run dev deploy

- **Decision:** D.1 deploys to Cloud Run dev (sevyn8-cortex-dev) for cold-start measurement. NOT local Docker simulation, NOT a synthetic VM benchmark.
- **Rationale:** Cold-start fidelity comes from the full Cloud Run runtime stack — image pull from Artifact Registry, container init under Cloud Run's Linux + V8 + libc combination, Serverless VPC Access Connector handshake, instance-startup probe behavior. Local Docker drops all of these and produces an unrelated number. The whole point of measuring is operational fidelity; lab measurement defeats the purpose.
- **Trade-off:** Requires GCP credentials + a deployable Slice D HTTP service in dev (which D.1 ships). Mitigation: deploy via `gcloud run deploy` from operator's authenticated shell, dev project only, single revision, scale-to-zero idle so cold starts are reproducible. Cost: ~$0.01 per measurement burst (Cloud Run free tier covers Phase 1 dev experimentation).
- **Reference:** ADR-HTTP-001 Condition 2 ("p95 cold-start in production-like Cloud Run conditions"). "Production-like" is the operative phrase.

### SD3 — Cold-start measurement methodology

- **Decision:** **30-invocation burst** after enforced scale-to-zero idle (≥ 15 min between bursts), measured via in-process OTel SDK from `@cortex/observability`'s `createTracer`. Span boundary: process spawn → first-request-handled. Cross-checked against Cloud Run's built-in `instance_startup_latencies` metric for sanity.
  - **Process spawn timestamp:** captured at `import.meta.url`-evaluation time (the earliest in-process moment we can mark).
  - **First-request-handled timestamp:** end of the `app.use('*', tracingMiddleware)` span for the first invocation per instance.
  - **p95:** sorted ascending, take the (0.95 \* 30 = 28.5)th value, round to the 29th. With 30 invocations, p95 is the 2nd-slowest result — not statistically robust on its own; `instance_startup_latencies` cross-check catches outlier bias.
  - **Pass:** p95 ≤ 500 ms AND mean ≤ 350 ms AND no individual invocation > 1500 ms.
- **Rationale:** Real measurement is what matters. The operationally meaningful question is not "what's the average cold start" but "how often does a user wait >500 ms on a cold start?" — p95 from a 30-burst is a noisy signal; cross-check via Cloud Run native metrics calibrates it. Definition of `process spawn` matters: container-pull and image-decompress happen before our process even starts, so we cannot measure them via OTel — Cloud Run metrics see them. Documented limitation; not a concern for our specific framework-choice question.
- **Trade-off:** 30 invocations may not be enough to nail down a stable p95 (high variance). Higher burst counts cost time (15-min idle gap × N bursts = hours). Mitigation: if 30-burst variance is high (range > 2× mean), expand to 60. We will know during D.1; SD3 records the starting methodology, not the only methodology.
- **Cadence mechanism (locked):** **Revision rotation via `gcloud run services update-traffic`** — between samples, dispatch traffic to a parking revision (or set `--to-revisions=PREVIOUS=100`), wait the enforced ≥15 min idle so the active revision scales to zero, then `--to-revisions=ACTIVE=100` to re-route. Each cycle is ~30 s of operator-side work; 30 samples × 15 min idle = ~7.5 hr wall-clock total (idle dominates; operator is unattended during idle). `gcloud run deploy` cycling rejected: each deploy churns a new image SHA + revision, conflating cold-start variance from revision-fresh effects (image-cache miss on Cloud Run worker, eager reconnect of dependent services) with the steady-state cold-start signal we want to measure. `update-traffic` keeps the revision constant; only the instance scales to zero and back.
- **Reference:** OTel auto-instrumentation behaviors per `@cortex/observability` Phase 2 patterns (commit `15e5574`); Cloud Run docs on `instance_startup_latencies`; `gcloud run services update-traffic` reference.

### SD4 — SIGTERM verification methodology

- **Decision:** Single-request slow-handler test, repeated 3× across separate revision deploys.
  - **Setup:** D.1 prototype includes a `/v1/test/slow-5s` endpoint (D.1-only; deleted before D.6) that resolves after 5 seconds.
  - **Test:** Issue request to `/v1/test/slow-5s`. While in-flight (~3 sec elapsed), trigger Cloud Run revision update via `gcloud run services update tenant-lifecycle-shared --revision-suffix=test-N` (or any harmless config change).
  - **Pass criteria:** (a) original request completes 2xx within original timeout (10s ≪ Cloud Run's idle, so no concern); (b) new revision serves new traffic by the time the slow request returns; (c) no `503 Service Unavailable` or connection-reset for the in-flight client.
  - **Repeat:** 3× across the deploy session; if all 3 pass, Condition 3 satisfied. If 1+ fails, reopen ADR-HTTP-001 per Condition 3's reopen trigger.
- **Rationale:** Cloud Run's SIGTERM grace period is 10 s, but in practice we want to verify behavior under the worst case: a request mid-handler. Single-request testing isolates the failure mode (vs. load testing which conflates instance scheduling with shutdown handling). 3 repeats catches flakes where one deploy worked but the underlying issue is intermittent.
- **Trade-off:** This doesn't test under load. If `@hono/node-server` has subtle behavior under high concurrency that's masked at single-request scale, we might pass D.1 but fail in production. Mitigation: D.1 adds a TODO in convention §8.1 (operational patterns) to revisit shutdown under load when first real Phase 2 traffic arrives. Phase 1 has 0 production tenants; this is a deferrable concern.
- **Reference:** Cloud Run documentation on `terminationGracePeriodSeconds` and SIGTERM dispatch; ADR-HTTP-001 Condition 3.

### SD5 — HTTP service package layout: `apps/tenant-lifecycle-api/`

- **Decision:** New app at `apps/tenant-lifecycle-api/` — a workload-specific app per CLAUDE.md SA-naming convention ("workload short-name"). Cloud Run service name will be `tenant-lifecycle-shared` (STANDARD) and `tenant-lifecycle-tenant-{uuid}` (ENTERPRISE) per ADR-COMPUTE-001 §3.
- **Rationale:** Three options considered:
  - **(a) `apps/api-gateway/`** — single HTTP service for all F0X workloads. Rejected: violates "one SA per workload" (F03 Temporal Engine, F04 Configuration Plane each get their own runtime SA per Slice C precedent + CLAUDE.md). Plus, an API gateway suggests fan-out routing, which Cortex doesn't have at this layer.
  - **(b) `services/lifecycle-http/`** — co-located with `services/foundation/`. Rejected: `services/` has been DB-substrate-only (foundation hosts migrations + helpers). Mixing HTTP services and DB substrate in `services/` blurs the workspace-layout convention.
  - **(c) `apps/tenant-lifecycle-api/`** — workload-specific app. **Selected.** Cloud Run service name aligns with ADR-COMPUTE-001 naming. Future F0X HTTP services follow the same pattern: `apps/temporal-engine-api/`, `apps/config-plane-api/`, etc. Slice D establishes the `apps/` HTTP-app convention.
- **Trade-off:** New workspace layout convention surfaces. Mitigation: CLAUDE.md "Workspace layout" section gets a one-paragraph addition describing `apps/<workload>-api/` as the HTTP-app pattern. Lands at D.6.
- **Reference:** `pnpm-workspace.yaml` already globs `apps/*` (verified). ADR-COMPUTE-001 §3 service-name format.

### SD6 — Key-rotation overlap window: 30-day KMS scheduled-destroy delay

- **Decision:** After a key rotation completes, the old key's `destroyVersion` schedule is set to **30 days**. New encrypts use the new key immediately. Old payloads (recorded with their original `keyResourceName`) decrypt successfully via the old key for the 30-day window.
- **Rationale:** Application-layer overlap is functionally infinite (envelope encryption records `keyResourceName` per payload per `@cortex/encryption`'s Slice B implementation; decryption looks up the recorded key, not the current key). The "overlap window" is really about how long the old key remains in KMS before destruction. 30 days matches:
  - GCP's max scheduled-destroy recovery window (24h–30d range).
  - Convention §7's existing reference: "the old key's destruction is delayed (typically 30 days)."
  - Cortex's incident-response posture: 30 days gives operators time to discover + recover from accidental rotation before key material is unrecoverable.
- **Trade-off:** Storage cost per old key version is negligible (<$0.06/month per version per GCP pricing). A shorter window (24h) would be cheaper but offers no incident-response margin. A longer window (90+ days) doesn't add value and risks regulatory friction (GDPR data minimization).
- **Reference:** `tenant-lifecycle-convention.md` §7 ("typically 30 days"); GCP KMS scheduled-destroy documentation.

### SD7 — HTTP API surface: 12 endpoints

- **Decision:** Confirmed surface, locked:

| #   | Method + Path                                        | Library function              | Notes                                                             |
| --- | ---------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| 1   | `POST /v1/tenants`                                   | `tenants.provision`           | Body: `CreateTenantInput`. Returns 202 + tenant + status.         |
| 2   | `GET /v1/tenants/{id}`                               | `tenants.get`                 | Read. 404 on TERMINATED per Q-NEW-C8 filter.                      |
| 3   | `GET /v1/tenants`                                    | `tenants.list`                | Read. Includes TERMINATED tombstones (intentional, per Q-NEW-C8). |
| 4   | `POST /v1/tenants/{id}/suspend`                      | `tenants.suspend`             | Body: `{ reason }`. SB1 audit shape.                              |
| 5   | `POST /v1/tenants/{id}/resume`                       | `tenants.resume`              | No body.                                                          |
| 6   | `POST /v1/tenants/{id}/offboard`                     | `tenants.offboard`            | Body: `{ gracePeriodDays? }`. Returns archive metadata.           |
| 7   | `POST /v1/tenants/{id}/terminate`                    | `tenants.terminate`           | No body. Operator-driven; respects grace + legal-hold.            |
| 8   | `POST /v1/tenants/{id}/force-terminate`              | `tenants.forceTerminate`      | Body: `{ reason }`. Super Admin override; SC2 audit shape.        |
| 9   | `POST /v1/tenants/{id}/rotate-keys`                  | `tenants.rotateKeys`          | No body. On-demand path; scheduled path uses Cloud Tasks worker.  |
| 10  | `POST /v1/tenants/{id}/legal-holds`                  | `legalHolds.set`              | Body: scope-discriminated union per SC3.                          |
| 11  | `POST /v1/tenants/{id}/legal-holds/{holdId}/release` | `legalHolds.release`          | Body: `{ releasedByUserId, releaseReason? }`.                     |
| 12  | `POST /v1/tenants/{id}/approve-dedicated-db`         | direct DB UPDATE (privileged) | Q-OPEN-6 fold-in. Sets `tenant.dedicated_db_approved=true`.       |

- **Rationale:** 9 mutating endpoints map 1:1 to existing library functions (Slices A/B/C). 2 read endpoints (`get` / `list`) cover SCR-24 + W01 read paths. 1 Enterprise-approval endpoint per F02 planning operational pattern 1 (Q-OPEN-6 fold-in). The future `regenerateOffboardingArchiveUrl` helper (Slice C deferred) is NOT in this list — Phase 1 has 0 production tenants; the helper is deferred per Q-NEW-C25 lock. Adding it now would be over-eager.
- **Trade-off:** 12 endpoints means ~12 route handlers + ~12 zod request schemas + ~12 response shapes. Substantial test surface. Mitigation: per ADR-HTTP-001 Condition 5, response shapes are RFC 9457 problem-details on errors; happy-path responses pass through library return values directly with minimal serialization. Test surface mostly checked via library-layer tests + thin integration layer (`app.request()` per Hono test patterns).
- **Reference:** F02 planning Slice D scope; ADR-HTTP-001 Condition 5; SC3 legal-hold discriminated union.

### SD8 — Authz model: Cloud Run invoker IAM, no per-method gates in Phase 1

- **Decision:** Cloud Run service deployed with `--no-allow-unauthenticated`. `roles/run.invoker` granted ONLY to specific caller SAs (initially empty — no Phase 1 callers exist). For development + testing, `cortex-tf-admin-{env}` SA's existing impersonation chain provides authenticated access. Per-method authz (e.g., "only X SA can call force-terminate") is deferred to AC01 per planning-doc D8 lock.
- **Rationale:** ADR-INFRA-006 establishes WIF as the auth-target identity layer; ADR-COMPUTE-001 + planning D8 lock Cloud Run service-to-service IAM as the floor. Phase 1 reality:
  - **No Phase 1 callers exist yet.** SCR-24 (Platform Ops Dashboard, P8.13) and W01 (Tenant Onboarding Wizard, P8.14) are the planned consumers; both ship in Phase 2+ work.
  - **Invoker-role-only** is the simplest enforceable floor: deny-by-default, allow-list per caller-SA when consumers ship.
  - **Per-method authz is AC01 territory.** Trying to ship per-method gates in Slice D forces Slice D to predict which caller does what — premature when callers don't exist.
- **Trade-off:** Anyone with the `cortex-tf-admin-{env}` SA's impersonation chain can call any endpoint, including `force-terminate`. Acceptable: that SA is already privileged (it can already destroy tenants directly via SQL in dev/staging). Production has no `cortex-tf-admin-prod` impersonation chain for non-operators (per ADR-INFRA-002 bootstrap design). When AC01 ships, per-method authz layers on top — Slice D code doesn't need to change; new authz middleware composes between buildTenantContextMiddleware and the route handlers.
- **Reference:** ADR-INFRA-006; ADR-COMPUTE-001 §5 (D8 lock); F02 planning §"Forcing functions" §10.12; future-roadmap §10.12.

### SD9 — D.1 commit shape: single commit

- **Decision:** D.1 lands as a single commit: `feat(F02-Slice-D): D.1 prototype (/health + /v1/tenants/{id} GET) — meets ADR-HTTP-001 Conditions 2+3`. Commit body includes:
  - The 30-burst cold-start measurement results (p50/p95/p99 numbers).
  - The 3-deploy SIGTERM verification results.
  - The `hono-pino` variant chosen (per Condition 4).
  - The `hono-problem-details` integration verification (per Condition 5).
  - Pass/fail decision against Conditions 2 + 3 (the gate).
- **Rationale:** Condition-2-and-3 results are operationally meaningful artifacts; embedding them in the commit body makes the decision auditable. Splitting D.1 (prototype / measurement / cleanup) makes 3 commits' worth of diff but isn't substantive — measurement code is a small handful of lines.
- **Trade-off:** Single commit is heavier (~300-500 lines code + tests + measurement narrative). Prefer single + large for the "this commit IS the gate result" narrative.
- **Reference:** Slice C 7.4 + 7.5 commit shape precedent (single substantial commits with measurement / verification narrative in body).

### SD10 — Time horizon: open-ended at slice level

- **Decision:** No fixed deadline. Effort estimate: **3–5 working days at solo-dev pace for D.1 → D.6**, matching the sub-phase plan's 24–36 hr nominal total. 2–3 days is achievable as a compressed best-case (no diagnostics on D.1, no TF module rework on D.4); 3–5 days is the honest planning-floor estimate. Either way, longer than Slice C's 1 day because of TF module scope + measurement work + 12-endpoint test surface.
- **Rationale:** Per F02 planning D12 (open-ended; per-slice estimation). Slice D's surface is materially heavier than Slice C: new TF module (~150 lines vs. Slice C's env wiring), 12 HTTP endpoints (vs. Slice C's library-layer additions), measurement work for Conditions 2+3 (no Slice C analog), real Cloud Run deploy (vs. Slice C's local-only). 3–5 days reflects honest estimation; daily HOLD-for-review checkpoints catch scope creep.
- **Trade-off:** Open-ended risks scope creep. Mitigation: HOLD review at end of each sub-phase (D.1 → D.6).
- **Reference:** F02 planning D12.

---

## Q-NEW# items

Surfaced during this planning session. Resolved inline where possible; unresolved items get a designated resolver sub-phase.

### Q-NEW-D-1 — Cold-start methodology (resolved at SD3)

Resolved by SD3. 30-burst, OTel SDK + Cloud Run native cross-check. If variance high, expand to 60.

### Q-NEW-D-2 — Convention §7 expansion: incremental or D.6-only?

- **Question:** Does each implementation sub-phase write the corresponding §7 subsection (Slice C 7.4 pattern — convention written alongside code), or does D.6 backfill all §7 subsections at once?
- **Resolution:** **Incremental.** Each sub-phase D.2–D.5 writes its corresponding §7 subsection alongside its code. D.6 reviews + finalizes (analogous to Slice C 7.7 final expansion + drift fixes). Rationale: backfilling at end risks doc-code drift; the Slice C precedent ([7.4 wrote convention §6.2, 7.5 wrote §6.3+§6.4]) showed incremental works.
- **Resolver sub-phase:** N/A — locked here.

### Q-NEW-D-3 — ADR-HTTP-002 (route conventions): needed?

- **Question:** Do route conventions (versioning, response shapes, idempotency keys, pagination) need an ADR before D.3 lands?
- **Resolution:** **No.** ADR-HTTP-001 scopes only the framework choice; route conventions are appropriately captured in convention `tenant-lifecycle-convention.md` §7 (operator runbook surface, not architectural decision). ADR-HTTP-002 deferred until a route-convention question becomes load-bearing across multiple F0X services. Phase 1 has only Slice D as the HTTP consumer; ADR is premature.
- **Resolver sub-phase:** N/A — defer until a future F0X HTTP service surfaces a question.

### Q-NEW-D-4 — Read endpoints (GET) in scope?

- **Question:** Are GET endpoints (`/v1/tenants/{id}` + `/v1/tenants`) in Slice D scope, or deferred to a future read-API slice?
- **Resolution:** **In scope.** Both are 1:1 wrappers around existing library functions (`tenants.get` / `tenants.list`). Excluding them means the HTTP API is mutation-only — a strange shape that forces every consumer to mix HTTP-mutates with direct-package-imports for reads. Acceptance criterion 7 ("end-to-end provisioning via HTTP") implicitly requires GET to verify state transitions. **2 endpoints, ~30 lines of code.**
- **Resolver sub-phase:** D.3.

### Q-NEW-D-5 — Enterprise approval endpoint: in scope?

- **Question:** Q-OPEN-6 fold-in says Slice D introduces the HTTP path for the manual-approval workflow. Is this in scope, or deferred until first Enterprise tenant?
- **Resolution:** **In scope.** Endpoint #12 (`POST /v1/tenants/{id}/approve-dedicated-db`) lands at D.3. The implementation is trivial: a privileged endpoint that does a direct UPDATE to `tenant.dedicated_db_approved=true` + emits an audit event (`TENANT_UPDATED` with structured payload — no new audit action needed). Mitigates F02 planning operational pattern 1's "direct DB update by Sevyn8 operator" friction.
- **Resolver sub-phase:** D.3 (handler + audit).

### Q-NEW-D-6 — `regenerateOffboardingArchiveUrl` HTTP endpoint?

- **Question:** Slice C deferred this helper per Q-NEW-C25. Slice D's HTTP layer is the natural place for the operator-facing path. Include now or defer?
- **Resolution:** **Defer.** Q-NEW-C25 explicitly defers this until first production tenant offboards. Phase 1 has 0 production tenants. Adding it pre-emptively would be a stub endpoint with no real call site.
- **Resolver sub-phase:** Deferred to "first production offboarding" trigger; tracked in `tenant-lifecycle-convention.md` §6.1.

### Q-NEW-D-7 — Key-rotation worker: same Cloud Run service or separate?

- **Question:** The 90-day scheduled rotation fires via `key-rotation-queue` Cloud Tasks. Does the worker run as `tenant-lifecycle-shared` (same as HTTP API) or as a separate service?
- **Resolution:** **Same service** (`tenant-lifecycle-shared`). The HTTP API service receives both HTTP traffic and Cloud Tasks invocations. Cloud Tasks-dispatched requests arrive as POSTs to a worker route (e.g., `POST /v1/_workers/key-rotation`); the route is Cloud-Tasks-only via OIDC token validation. Rationale: same code path = same observability + same deploy lifecycle; spinning up a second service for a single worker entry point is over-engineered for Phase 1's traffic volume.
- **Resolver sub-phase:** D.2 (worker route alongside the workflow function); D.4 (TF binding for Cloud Tasks SA → invoker IAM).

### Q-NEW-D-8 — §10.4 DB client abstraction: surface in Slice D?

- **Question:** F01 Slice C planning §"Roadmap §10.4" said: "Slice D might surface this — does it?"
- **Resolution:** **Yes — minimally.** Slice D's HTTP middleware needs a per-request DB connection bound to the request's tenant. Workspace pattern: `withTenantDbClient(pool, tenantId, async (boundDb) => ...)`. The HTTP middleware closes over this; doesn't need a tier-aware `getTenantDbClient(tenantId)` factory yet (single shared Cloud SQL in Phase 1; Enterprise dedicated DB lights up post-ADR-INFRA-007). §10.4 stays open as a future tier-aware factory; Slice D's middleware uses the existing `withTenantDbClient` directly.
- **Resolver sub-phase:** D.3 (middleware composition); §10.4 unchanged (still F02+ territory for tier-aware routing).

### Q-NEW-D-9 — Workspace deps: stage Hono companion adds across sub-phases or all in D.1?

- **Question:** ADR-HTTP-001 lists 5–6 new deps (`hono`, `@hono/node-server`, `@hono/otel`, `@hono/zod-validator`, `hono-pino`, `hono-problem-details`). All in D.1 or staged?
- **Resolution:** **All in D.1.** D.1 establishes the full Hono stack including the deps for OTel + logging + error response shape. Splitting deps across sub-phases creates dep-installation churn + risks D.1's gate verifying a partial stack (e.g., cold-start without the actual OTel + pino fully wired). Single dep-add commit at D.1; later sub-phases add zero new framework deps.
- **Resolver sub-phase:** D.1 (single dep-add at the top of the sub-phase).

### Q-NEW-D-10 — `tenant-cloud-run-service` TF module: STANDARD shared deployment in Slice D, or ENTERPRISE-only?

- **Question:** The module is meant for ENTERPRISE per-tenant deploys (`{workload}-tenant-{uuid}`). Does Slice D also instantiate the STANDARD shared service (`tenant-lifecycle-shared`) using this module, or is the shared service deployed via a separate inline TF resource?
- **Resolution:** **The module shapes both.** `tenant-cloud-run-service` accepts a `mode` variable (`'shared' | 'tenant'`) plus `tenant_id` (required when `mode='tenant'`, ignored when `mode='shared'`). Module yields naming per ADR-COMPUTE-001 (`{workload}-shared` or `{workload}-tenant-{uuid}`). Per-env wiring instantiates the shared service in D.4. ENTERPRISE per-tenant instances aren't created at infra-apply time — they're created on-demand by `tenants.provision`'s ENTERPRISE branch (Slice A's STUB per Q-NEW-C5 lights up using this module). Module covers both shapes; shared service deploys at D.4; ENTERPRISE per-tenant deploys remain swap-path stubs lighting up post-ADR-INFRA-005.
- **Resolver sub-phase:** D.4.

### Q-NEW-D-11 — Tenant-lifecycle-runtime SA already shipped (Slice C 7.6); does Slice D need any new SAs?

- **Question:** What runtime / caller SAs need to land in Slice D?
- **Resolution:** **No new runtime SAs.** `tenant-lifecycle-runtime-{env}` already exists per Slice C 7.6 (commit `e6e44c9`); Slice D's Cloud Run service runs as this SA. Cloud Tasks invoker SA: a separate `cortex-tasks-invoker` SA may be needed for the OIDC token validation at the worker route, but per ADR-LIFECYCLE-001 §3 (Cloud Tasks → Cloud Run OIDC), the invoker SA is configured per-task at dispatch (we already pass it in `dispatchCloudTask`'s OIDC token). Slice D might need to mint a dedicated `tenant-lifecycle-invoker-{env}` SA for the worker routes vs. the runtime SA — punt to D.4.
- **Resolver sub-phase:** D.4 (TF for invoker SA if needed).

### Q-NEW-D-12 — Convention §7 currently has substantive workflow shape; does D.2's content overwrite or extend?

- **Question:** §7 is a "Slice D placeholder" with workflow shape pinned by Slice A. D.2's key-rotation implementation: extend the placeholder or rewrite from scratch?
- **Resolution:** **Extend.** Slice C 7.4–7.7 followed the same pattern: §6 had a Slice A placeholder; sub-phases extended subsections with the actual implementation details. D.2 writes §7.1 (workflow shape — extends the existing pinned content), §7.2 (dual-key overlap mechanics), §7.3 (rotation cadence + on-demand path), §7.4 (worker route + Cloud Tasks integration), §7.5 (idempotency + failure recovery), §7.6 (forensic queries). D.6 finalizes + adds drift fixes if any.
- **Resolver sub-phase:** D.2 (initial subsections); D.6 (finalize).

---

## Q-OPEN# items (deferred to post-F02)

- **AC01 per-method authz** (P2.1): Slice D Cloud Run invoker IAM is the floor; per-method gates layer on top when AC01 ships. ADR-HTTP-001 + planning D8 already track this.
- **W01 admin-invite consumer** (P8.14): F02 emits `TENANT_PROVISIONED`; W01 consumes. Slice D's HTTP API does not block on W01.
- **Multi-tenant saga pattern**: F03+ concern when concurrent provisioning becomes load-bearing. Phase 1 dedup is `taskId='provisioning-{tenantId}'`.
- **Automated Enterprise approval at volume trigger**: Currently manual via endpoint #12. F02 planning operational pattern 1: when Enterprise volume reaches ~10/month, automate the approval gate (cost-policy validation + signature-based approval). Tracked in roadmap.
- **§10.4 tier-aware DB client factory**: Slice D uses `withTenantDbClient` directly. Tier-aware `getTenantDbClient(tenantId)` lights up when ENTERPRISE per-tenant Cloud SQL ships (post-ADR-INFRA-007).
- **`regenerateOffboardingArchiveUrl` HTTP endpoint**: Q-NEW-D-6 deferral. Lights up at first production offboarding.
- **Load-tested SIGTERM behavior**: Q-NEW-D-1 / SD4 disclosure. Single-request testing in D.1; load-tested verification deferred to first Phase 2 traffic.

---

## Spec drifts handled

### Drift 1 — Spec §F02 "K8s namespace per Enterprise tenant" → Cloud Run

Already handled in F02 planning Drift 1 (locked 2026-04-27; ADR-COMPUTE-001 supersedes). Slice D's TF module (`tenant-cloud-run-service`) is the operator-side realization.

### Drift 2 — Spec §F02 "Pre-signed URL TTL: 30 days" → 7-day URL TTL + 30-day object retention

Already handled in Slice C Q-NEW-C6. Slice D inherits unchanged; convention §6.1's staged-rollout note already documents the URL/retention split. No Slice-D-specific drift.

### Drift 3 — Spec §F02 "F02 emits provisioning.completed event" → audit-only emission

F02 spec says "emit provisioning.completed event"; Slice A landed `TENANT_PROVISIONED` audit emission. No Pub/Sub integration; audit chain is the event substrate. Slice D's HTTP API does not change this — `tenants.provision`'s audit emission flows through unchanged. Convention `tenant-lifecycle-convention.md` §9.1 captures this. No new drift.

### Drift 4 — Spec §F02 "scheduled-job halt on suspension"

Spec §2 references "halt all scheduled jobs for the tenant" on suspension. Slice B emits `TENANT_SUSPENDED` audit; downstream cascades (S15 device pause, S17 outbound stop) are push-style subscribers when those modules ship. Slice D's HTTP API does not change this — endpoint #4 (`POST /v1/tenants/{id}/suspend`) is a thin wrapper around `tenants.suspend`. No new drift.

### Drift 5 — HTTP endpoint count expanded 9 → 12 during planning

F02 planning §"Slice D" listed 9 lifecycle endpoints (the 9 mutating workflows). Slice D planning expanded the surface to 12: **+2 read endpoints** (`GET /v1/tenants/{id}` and `GET /v1/tenants` per Q-NEW-D-4 / acceptance criterion 7) + **1 Enterprise-approval endpoint** (`POST /v1/tenants/{id}/approve-dedicated-db` per Q-OPEN-6 fold-in / Q-NEW-D-5). Convention `tenant-lifecycle-convention.md` §7 captures the full surface as the operator-facing canonical list.

---

## Forcing functions resolved (§10 items Slice D closes)

| §10 item                              | Slice D resolution                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **§10.11** HTTP framework choice      | RESOLVED 2026-04-29 by ADR-HTTP-001. Slice D enforces the 6 binding conditions.                    |
| **§10.12** Tenant CRUD authz layer    | PARTIALLY RESOLVED by Slice D (Cloud Run invoker IAM as floor); per-method authz remains AC01.     |
| **§10.4** DB client abstraction shape | UNCHANGED by Slice D. Q-NEW-D-8 confirmed: `withTenantDbClient` direct use; no tier-aware factory. |
| **§10.10** Workspaces / hierarchies   | UNCHANGED. AC02 ownership.                                                                         |
| **§10.15** FOR UPDATE contention test | RESOLVED 2026-04-27 by Slice B. Inherited unchanged.                                               |

---

## Sub-phase plan

| #   | Title                                                    | Estimate | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Acceptance                                                                                                                                                                                                                                                                                                                              | Dependencies                                                                                                                                               |
| --- | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D.1 | Prototype + Conditions 2+3 gate                          | 6–8 hr   | `apps/tenant-lifecycle-api/` scaffold (package.json, tsconfig, Dockerfile) + Hono app with 2 endpoints (`/health`, `GET /v1/tenants/{id}`) + 5–6 deps from ADR-HTTP-001 (per Q-NEW-D-9) + OTel cold-start instrumentation per SD3 + slow-handler test endpoint (`/v1/test/slow-5s`) + measurement narrative in commit body per SD9. Real Cloud Run dev deploy per SD2.                                                                                                   | (a) p95 cold-start ≤ 500 ms across 30-burst (SD3); (b) 3× SIGTERM verification clean (SD4). If pass: proceed to D.2. If fail: reopen ADR-HTTP-001 (per Verification section).                                                                                                                                                           | D.0.5 (ADR)                                                                                                                                                |
| D.2 | Key rotation workflow                                    | 4–6 hr   | `tenants.rotateKeys(db, tenantId, ctx)` library workflow. Updates `tenant_kms_key.kms_key_resource_name` + `tenant.last_key_rotated_at = now()`. Emits `TENANT_KEY_ROTATED` audit (already in catalog — Slice A). Worker route at `POST /v1/_workers/key-rotation` (Cloud-Tasks-only via OIDC validation per Q-NEW-D-7). Old key `destroyVersion` scheduled at +30 days per SD6. Tests parallel to `terminate.spec.ts` shape. Convention §7.1–§7.3 written (Q-NEW-D-12). | (a) Round-trip rotation works against `p09-repro`; (b) old payloads decrypt successfully via recorded `keyResourceName` (overlap test); (c) OIDC validation rejects unauth requests at worker route; (d) audit row emitted with `before_state`/`after_state`.                                                                           | D.1                                                                                                                                                        |
| D.3 | HTTP API — full surface                                  | 6–10 hr  | 12 endpoints per SD7 wired into Hono app. Validation via `@hono/zod-validator`. Error translation via `app.onError` + `HTTPException` + `hono-problem-details` (RFC 9457 + workspace-extended `{code, message, correlation_id, details?}`). Tests via `app.request()` per Hono test patterns. Convention §7.4 written (Q-NEW-D-12).                                                                                                                                      | (a) all 12 endpoints round-trip with happy + error paths; (b) error responses match RFC 9457 + workspace envelope; (c) validation rejects malformed inputs with 400; (d) acceptance criterion 7 (end-to-end provisioning via HTTP) demonstrated in test.                                                                                | D.1, D.2                                                                                                                                                   |
| D.4 | TF: tenant-cloud-run-service module + key-rotation-queue | 4–6 hr   | New module `infra/terraform/modules/tenant-cloud-run-service/` parameterized by `mode='shared'                                                                                                                                                                                                                                                                                                                                                                           | 'tenant'`+`workload`+`tenant_id`(per Q-NEW-D-10).`key-rotation-queue`Cloud Tasks queue per env (Slice C 7.6 precedent). Per-env wiring: instantiate`tenant-lifecycle-shared`Cloud Run service via the module. Maybe new`tenant-lifecycle-invoker-{env}` SA per Q-NEW-D-11 (decided at sub-phase). Convention §7.5 written (Q-NEW-D-12). | (a) `make tf-plan-dev` clean diff per env (3 envs); (b) module validates with both `mode` shapes; (c) Cloud Run service deploys + receives traffic in dev. | D.1, D.3 |
| D.5 | IAM authz — invoker IAM + integration test               | 2–3 hr   | Cloud Run service `--no-allow-unauthenticated` flag set. `roles/run.invoker` granted to `cortex-tf-admin-{env}` SA (operator + test access). Integration test verifies (a) unauth GET → 403; (b) authenticated test SA GET → 2xx; (c) `cortex-tf-admin-dev` impersonation works. Convention §7.6 written (Q-NEW-D-12).                                                                                                                                                   | All 3 integration test cases pass.                                                                                                                                                                                                                                                                                                      | D.4                                                                                                                                                        |
| D.6 | Convention §7 finalize + Slice D close commit            | 2–3 hr   | Convention §7 review + drift fixes + final structural pass (analogous to Slice C 7.7). CLAUDE.md `apps/<workload>-api/` workspace-layout convention addition (per SD5). status.md update: P1.2 F02 Slice D ✓; F02 closes; P1.3 F03 unblocked. Slice D close commit `feat(F02-Slice-D): closes Slice D — key rotation + HTTP API + TF + IAM authz`.                                                                                                                       | (a) §7 has 6 subsections matching §6's 7-subsection density (or close); (b) status.md reflects Slice D closure + F02 closure + P1.3 readiness; (c) CI green on close commit.                                                                                                                                                            | D.1, D.2, D.3, D.4, D.5                                                                                                                                    |

**Total nominal:** 24–36 hours = 3–5 working days at solo-dev pace. Cushion at the high end for D.3's 12-endpoint test surface + D.4's TF module work.

---

## D.1 pass/fail decision tree

The Sub-phase plan row collapses D.1 to binary pass/fail. The full ladder lives here so the operator's decision is unambiguous when measurement lands at the boundary. Both conditions evaluate independently; D.1 only proceeds to D.2 when **both** rows below pass (or pass-with-headroom).

### Cold-start (Condition 2 — p95 ≤ 500 ms)

| Result                                      | Status    | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p95 ≤ 350 ms AND mean ≤ 250 ms              | PASS      | Proceed to D.2. Record numbers in commit body per SD9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| p95 350–500 ms AND mean ≤ 350 ms            | PASS      | Proceed to D.2. Note the headroom in commit body; convention §8.1 captures a Phase 2 traffic re-measure trigger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| p95 500–650 ms                              | SOFT FAIL | Diagnose source per ADR-HTTP-001 Verification ("diagnose before deciding whether the framework choice or the architecture is at fault"). Three diagnostic branches: (a) `import.meta` → `app.fetch()` ready dominant → Hono / deps init suspect → reopen ADR. (b) `pg` pool warmup dominant → architecture; lazy-init the pool, re-measure. (c) `@google-cloud/*` SDK init dominant → architecture; lazy-init SDK clients, re-measure. After diagnosis, run one second-pass burst. If still > 500 ms, escalate per next row. If now ≤ 500 ms, document the architecture fix in commit body and proceed. |
| p95 > 650 ms                                | HARD FAIL | Reopen ADR-HTTP-001. D.2+ blocked. Document framework re-evaluation outcome in updated ADR before any further D.X work. Fallback path: Express adapter (already structurally shipped in `@cortex/tenant-context`).                                                                                                                                                                                                                                                                                                                                                                                      |
| Single invocation > 1500 ms (any one of 30) | HARD FAIL | Reopen ADR-HTTP-001 even if p95 passes — a 1.5 s+ tail on first hit per scale-from-zero is operator-visible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 30-burst variance high (range > 2× mean)    | EXPAND    | Expand to 60-burst per SD3 cushion. Re-evaluate against thresholds above with the 60-burst result. Don't make the pass/fail call on the noisy 30-burst.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Worked thresholds for the brief's examples:**

- **480 ms p95** (mean ≈ 280 ms) → row 2 (PASS-with-headroom). Proceed to D.2; note in commit.
- **520 ms p95** → row 3 (SOFT FAIL). Diagnose source. Most likely architecture (pg pool warmup) is dominant; lazy-init the pool, re-measure. If now ≤ 500 ms, proceed; if still > 500 ms, escalate to row 4.
- **800 ms p95** → row 4 (HARD FAIL). Reopen ADR-HTTP-001. D.2+ blocked.

### SIGTERM (Condition 3 — clean exit ≤ 10 s, in-flight 2xx, 3 sequential deploys)

| Result                                                               | Status      | Action                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3/3 deploys: clean exit ≤ 8 s, in-flight 2xx                         | PASS        | Proceed to D.2.                                                                                                                                                                                                                                                                                                       |
| 3/3 deploys: clean exit 8–10 s, in-flight 2xx                        | PASS        | Within Cloud Run grace; proceed to D.2. Note margin in commit body. Convention §8.1 captures a load-test follow-up for first Phase 2 traffic.                                                                                                                                                                         |
| 3/3 deploys: clean exit 10–11 s, in-flight 2xx (over grace by < 2 s) | SOFT FAIL   | Cloud Run will SIGKILL beyond 10 s. Investigate likely cause: `@hono/node-server` close-callback dispatch latency, or insufficient safety margin in our shutdown handler (subtract 2 s from Cloud Run's 10 s window before forcing exit). Apply the fix; re-test 3 fresh deploys. If pass, proceed; if not, escalate. |
| Any deploy: clean exit > 11 s                                        | HARD FAIL   | Reopen ADR-HTTP-001 per Condition 3 fallback. Switch to vanilla `node:http` server with Hono via `app.fetch(req)` (~50 lines per ADR Condition 3 reopen-trigger). Re-test 3 deploys against the fallback before resuming D.2.                                                                                         |
| Any deploy: in-flight 503 / connection-reset                         | HARD FAIL   | Same as > 11 s row: reopen ADR + fallback. Condition 3's whole point is in-flight request preservation; a single dropped request per deploy is customer-visible.                                                                                                                                                      |
| 1 of 3 deploys fails (flake?)                                        | INVESTIGATE | Repeat with 5 fresh deploys. If 2/5 fail, treat as HARD FAIL. If 1/5, treat as PASS-with-watch and flag in convention §8.1 as a deferred-investigation item. Don't ship a "1-in-3 fails sometimes" gate result.                                                                                                       |

**Worked thresholds for the brief's examples:**

- **8 s clean exit, 3/3 deploys** → row 1 (PASS). Proceed.
- **11 s clean exit, 3/3 deploys** → row 4 (HARD FAIL on the > 11 s threshold). Reopen ADR per Condition 3 fallback. Switch to vanilla `node:http` + Hono `app.fetch`; re-test before resuming D.2.

---

## Risks & mitigations

- **D.1 cold-start fails the 500ms threshold.** Mitigation: ADR-HTTP-001 Condition 2 reopen-trigger explicitly says "diagnose source before deciding framework re-evaluation." First-line diagnosis: split cold-start latency into (a) container pull + boot (Cloud Run native metrics), (b) `import.meta.url` → `app.fetch()` ready (Hono + deps init), (c) first-request handle (DB pool warmup on first query). If (b) is the dominant component, framework is suspect; if (a) or (c), architecture is suspect (image size or pool warmup). Diagnostic before reaction.

- **D.1 SIGTERM fails 3× verification.** Mitigation: Per ADR-HTTP-001 Condition 3 fallback: switch to vanilla `node:http` server with Hono via `app.fetch(req)`. ~50 lines of code; not a slice-blocking change. Convention §8.1 captures the fallback as a documented operational pattern.

- **HTTP API test surface explosion (12 endpoints × happy + error paths).** Mitigation: error-path tests share fixtures (one fixture per error class from `@cortex/tenant-context`); happy-path tests are thin (the library tests already cover business logic). Estimate: ~25-30 new tests at D.3. Re-use `app.request()` patterns from Slice C's test fixtures.

- **Cloud Run dev deploy + measurement adds GCP costs.** Mitigation: Cloud Run free tier covers Phase 1 dev experimentation (~2M requests + ~360K vCPU-seconds free per month). 30-burst cold-start measurements + 3 SIGTERM tests + ~50 integration test invocations = ~100 invocations + ~5 deploys = well within free tier.

- **TF module spans both `mode='shared'` and `mode='tenant'`.** Risk: module variation paths drift (one path tested, the other rotted). Mitigation: D.4 acceptance includes "module validates with BOTH `mode` shapes" — explicit `terraform validate` against synthetic root that exercises both variants.

- **Convention §7 currently has substantive content; D.2's writes might conflict with existing structure.** Mitigation: Q-NEW-D-12 resolution: extend existing §7 placeholder with subsection structure §7.1–§7.6; D.6 reviews + reconciles. Slice C 7.7 precedent: §6 grew 4→7 subsections; can replay same pattern for §7.

- **`cortex-tf-admin-{env}` impersonation chain in dev gives broad invoker access.** Risk: any operator with tf-admin can call any endpoint, including `force-terminate`. Mitigation: documented in convention §7.6; AC01 layers per-method authz when it ships. Phase 1 has zero production tenants and a single operator; the risk is theoretical.

---

## References

- **F02 build prompt §P1.2** — `docs/build-prompts/cortex_build_prompts_v3.md` lines 997–1050.
- **F02 planning** — `docs/planning/f02-tenant-lifecycle-scope.md` D1–D12 + §"Slice D" scope (line ~302).
- **D.0 spike** — `docs/spikes/2026-04-28-hono-prod-readiness.md` (12-category Hono evaluation).
- **D.0.5 ADR-HTTP-001** — `docs/architecture/decisions/ADR-HTTP-001-hono-as-http-framework.md` (the 6 binding conditions).
- **ADR-LIFECYCLE-001** — `docs/architecture/decisions/ADR-LIFECYCLE-001-state-machine-and-cloud-tasks.md` (substrate D.2 extends).
- **ADR-COMPUTE-001** — `docs/architecture/decisions/ADR-COMPUTE-001-cloud-run-vs-k8s-compute-isolation.md` (D10 inherits service-name format; D8 inherits IAM model).
- **ADR-INFRA-006** — `docs/architecture/decisions/ADR-INFRA-006-workload-identity-federation.md` (auth-target identity layer).
- **ADR-INFRA-007** — `docs/architecture/decisions/ADR-INFRA-007-per-tenant-cmek-migration-path.md` (per-tenant CMEK migration; key rotation operates over this).
- **Convention** — `docs/architecture/tenant-lifecycle-convention.md` (§7 currently placeholder; D.2-D.6 write the full subsections).
- **Audit catalog** — `packages/tenant-context/src/audit-actions.ts` (`TENANT_KEY_ROTATED` already registered at Slice A; no new actions needed).
- **Workspace middleware adapter** — `packages/tenant-context/src/middleware.ts` (`buildTenantContextMiddleware().hono(c, next)` shipped Slice A).
- **Slice C planning precedent** — `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md` (template structure: SD#-locked decisions + sub-phase table + risks + references).
- **Slice C close** — `docs/architecture/tenant-lifecycle-convention.md` §6 + planning doc updates (commit `135c9da`).
- **Future-roadmap** — `docs/future-roadmap.md` §10.11 (RESOLVED by ADR-HTTP-001), §10.12 (PARTIALLY RESOLVED by Slice D), §10.4 (UNCHANGED).

---

## Appendix A — Convention §7 outline

Slice D fills `tenant-lifecycle-convention.md` §7 across D.2 → D.6. Outline (subsection-by-subsection, paralleling §4 + §5 + §6 density precedents):

### §7.1 — Workflow shape (D.2)

- `tenants.rotateKeys(db, tenantId, ctx)` signature + audit emission.
- 90-day cadence detection (`now() - tenant.last_key_rotated_at > 90 days`).
- On-demand path via HTTP endpoint #9.
- TENANT_KEY_ROTATED audit with `before_state.kms_key_resource_name` + `after_state.kms_key_resource_name`.

### §7.2 — Dual-key overlap mechanics (D.2)

- Application-layer overlap is functionally infinite (envelope encryption per `@cortex/encryption` records `keyResourceName`; decryption uses recorded key, not current key).
- KMS-side: old key `destroyVersion` scheduled at +30 days per SD6.
- In-flight encrypts/decrypts succeed during cutover (acceptance criterion 3).

### §7.3 — Rotation cadence + on-demand path (D.2)

- `key-rotation-queue` Cloud Tasks queue dispatches scheduled rotations.
- Worker pre-check on `tenant.last_key_rotated_at` (idempotency).
- On-demand: HTTP endpoint #9 dispatches a Cloud Task with `taskId='rotate-{tenantId}'` (D5 dedup pattern).
- Operator runbook: how to trigger an emergency rotation.

### §7.4 — Worker route + Cloud Tasks integration (D.2 + D.4)

- `POST /v1/_workers/key-rotation` route receives Cloud-Tasks-dispatched invocations.
- OIDC token validation per ADR-LIFECYCLE-001 §3.
- Audit emission patterns (worker actor vs caller actor).
- Idempotency on retry.

### §7.5 — Idempotency + failure recovery (D.2 + D.4)

- Re-dispatched rotation: pre-check tenant.last_key_rotated_at against threshold; no-op if already rotated within 24h window.
- Failure modes: KMS unavailable (Cloud Tasks retries), DB write fails (txn rollback), audit emit fails (txn rollback).
- Operator runbook: how to recover from a stuck rotation.

### §7.6 — IAM + invoker authz (D.5)

- Cloud Run service deployed with `--no-allow-unauthenticated`.
- `roles/run.invoker` allowlist per caller-SA.
- Phase 1: only `cortex-tf-admin-{env}` SA has access (operator + test).
- Forensic queries: who rotated keys, when, via which path (scheduled vs on-demand).
- Cross-references to AC01 (per-method authz) future evolution.

### §7.7 — Forensic queries (D.6, parallels §4.7 / §5.7 / §6.7)

- All key rotations within a date range.
- Rotations by tenant (forensic chain).
- Rotations dispatched on-demand vs scheduled (action attribution).
- Rotations that failed and retried (Cloud Tasks attempt counts via audit metadata).

Total expected §7 density at Slice D close: ~7 subsections, ~250-350 lines (matching §4 / §5; less than §6's 522 because key rotation is a smaller surface than offboarding+termination+force+legal-hold).

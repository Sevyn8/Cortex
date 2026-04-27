# ADR-LIFECYCLE-001: Tenant lifecycle state machine + Cloud Tasks orchestration

**Status:** Accepted
**Date:** 2026-04-27
**Deciders:** Amit (Sevyn8 engineering)
**Context documents:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.2 (lines 997–1050), Cortex v2.2 Spec §F02, `docs/planning/f02-tenant-lifecycle-scope.md` (D1–D12 + Q-OPEN-1 through Q-OPEN-6 + SA1–SA15), ADR-COMPUTE-001 (Cloud Run vs K8s), ADR-INFRA-007 (per-tenant CMEK), ADR-AU-001 (audit-events library), ADR-DB-002 (RLS baseline)
**Companion decisions:** ADR-COMPUTE-001 (placement model — branched inside the worker), ADR-INFRA-007 (substrate-now / real-impl-later precedent — same shape as the F02 stub swaps), ADR-AU-001 (audit emission + verb diversity for D6 hybrid catalog)

This is the first ADR in the `LIFECYCLE-*` series. Future lifecycle
decisions (per-tenant Cloud SQL provisioning shape, tenant data-export
archive format, cross-region failover semantics) extend this series.

---

## Context

F02 (Tenant Lifecycle Manager) introduces six async workflows on top of
F01's substrate:

1. **Provisioning** — REQUESTED → PROVISIONING → READY → ACTIVE.
   Multi-step pipeline: KMS key binding, GCS prefix, dedicated Cloud SQL
   for Enterprise, control-plane inserts, smoke test. Spec §1 says
   "driven by Cloud Tasks."
2. **Suspension** — ACTIVE → SUSPENDED. Block writes, allow reads;
   emit cascade event for AC01 / S15 / S17.
3. **Resume** — SUSPENDED → ACTIVE.
4. **Offboarding** — ACTIVE / SUSPENDED → OFFBOARDING. Generate signed-URL
   export archive (30-day TTL); schedule termination at grace period.
5. **Termination** — OFFBOARDING → TERMINATED. Hard delete: per-tenant
   Cloud Run service(s), GCS prefix, dedicated Cloud SQL, shared-DB
   rows, KMS key tombstone.
6. **Key rotation** — 90-day default + manual on-demand. Dual-key
   overlap window for in-flight encrypts/decrypts.

Slice A ships provisioning (this ADR's substrate). Slices B / C / D
extend the same machinery to the remaining five workflows. Each
workflow is multi-step (several GCP API calls + DB writes + audit
events), each must survive partial failures, each is idempotent on
re-dispatch, each requires a forensic audit trail, and each branches
on `tenant.tier` (STANDARD vs ENTERPRISE — the latter triggers
dedicated Cloud Run + dedicated Cloud SQL provisioning per
ADR-COMPUTE-001 + ADR-INFRA-005).

Without an ADR, F02 has too many open architectural questions for
slice-level decision-making to track (state model? what the worker
runs in? how transient errors differ from unrecoverable? where
audit emission fits?). This ADR locks the substrate so Slices B / C /
D inherit a uniform pattern, not a re-litigation of orchestration
fundamentals.

The companion planning doc (`docs/planning/f02-tenant-lifecycle-scope.md`)
records the per-decision rationale (D1–D12, Q-OPEN-1 through Q-OPEN-6,
SA1–SA15) for Slice A choices. This ADR distills the architecture-level
decisions worth carrying forward as a permanent reference.

---

## Decision

### 1. Tenant lifecycle state machine — 7 states

The tenant table's `status` column carries a 7-value enum (per
migration 0010, extending the 4-value enum from migration 0007):

```
REQUESTED → PROVISIONING → READY → ACTIVE
                                      ↓
                                  SUSPENDED ↔ ACTIVE
                                      ↓
                                  OFFBOARDING → TERMINATED
```

Per-state semantics:

| State          | Meaning                                                                                                      | Set by                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `REQUESTED`    | Provisioning kickoff awaited. ENTERPRISE tenants additionally await `dedicated_db_approved=true` (Q-OPEN-6). | `tenants.provision` (initial INSERT for ENTERPRISE).                                         |
| `PROVISIONING` | In-flight pipeline (KMS, GCS, Cloud SQL, control plane).                                                     | `tenants.provision` (initial INSERT for STANDARD); worker advances ENTERPRISE post-approval. |
| `READY`        | Provisioning success; smoke test passed. Tenant has substrate but is not yet serving traffic.                | Worker after `runSmokeTest`.                                                                 |
| `ACTIVE`       | Tenant is live and serving traffic.                                                                          | Worker (post-READY transition).                                                              |
| `SUSPENDED`    | Write-blocked; reads allowed (data export still works); scheduled jobs halted.                               | `tenants.suspend` (Slice B).                                                                 |
| `OFFBOARDING`  | Export archive generation in progress; grace period running.                                                 | `tenants.offboard` (Slice C).                                                                |
| `TERMINATED`   | Hard-deleted. Post-termination queries return `tenant-not-found` per spec §3.                                | `tenants.terminate` (Slice C).                                                               |

**Allowed transitions are enforced in two places:**

1. The DB CHECK constraint (`tenant_status_check` per migration 0010)
   is the value-set guard — only the 7 enum values are permitted.
2. The `ALLOWED_TRANSITIONS` map in `@cortex/tenant-context/src/tenants.ts`
   is the transition guard — `setStatus(from, to)` rejects any
   non-permitted edge with `TenantStatusError`.

The DB and code maps must stay in sync. Migration 0010's `ALLOWED_TRANSITIONS`
extension landed in the same commit as the column extension to enforce
this invariant.

**Backward-compat edge — `PROVISIONING → ACTIVE` retained alongside
`PROVISIONING → READY → ACTIVE`** (per planning-doc SA12 Option a). Slice
A's existing test fixtures and bootstrap code use the direct path; F02
provisioning workflow uses the explicit READY-gated path. Both are
permitted. Convention doc §1 documents the dual-path tolerance and the
plan to retire the direct edge once all fixtures route via READY.

### 2. Async orchestration — Cloud Tasks

All six lifecycle workflows are dispatched via Google Cloud Tasks:

- **`provisioning-queue`** — Slice A `tenants.provision`.
- **`lifecycle-queue`** — Slices B/C `tenants.{suspend, resume, offboard, terminate}`.
- **`key-rotation-queue`** — Slice D `tenants.rotateKeys`.

Per-queue config (per Q-OPEN-1):

- **Retry policy:** Cloud Tasks default exponential backoff (30s → 5min
  → 30min cap), max 5 attempts.
- **Concurrency cap:** 10 concurrent dispatches per queue. Each
  provisioning is 5–30 min; >10 risks DB connection-pool exhaustion.
- **Dedup:** Cloud Tasks `taskId='{verb}-{tenant_id}'` (~1h dedup
  window). E.g., `provisioning-{uuid}`, `termination-{uuid}`.

Worker dispatch is HTTP-triggered (Cloud Run service receives a POST
with the JSON-serialized payload base64-encoded into the request body).
The worker function lives in `@cortex/tenant-context/src/provisioning-worker.ts`
(Slice A); future verbs add their own worker files following the same
shape.

### 3. Idempotency primitive — taskId dedup + worker pre-check

Two-layer defense (per planning-doc SA11):

1. **Cloud Tasks `taskId` dedup** prevents most duplicate enqueue
   attempts (~1h window). The dedup is at the queue layer; duplicate
   `createTask` calls within the window return success without
   creating a new task.
2. **Worker pre-check** handles edge cases where dedup misses (network
   partition during enqueue, dedup-window expiry during long retries).
   The worker reads `tenant.status` first; if status is already at or
   past the target state for the verb, the worker no-ops and returns
   success.

Pre-check shape per workflow (Slice A example):

```ts
if (initial.status !== 'REQUESTED' && initial.status !== 'PROVISIONING') {
  return; // already advanced; idempotent no-op
}
```

This pattern is extended verbatim by Slices B / C / D for their
respective workflows.

### 4. Rollback semantics — hard rollback on known-unrecoverable failure

Per planning-doc SA10 + SA14:

- **Known-unrecoverable failures** (smoke test fails after substrate
  inconsistency; future failure modes added as patterns emerge):
  worker calls `cleanupFailedProvisioning(db, tenantId)` which deletes
  substrate atomically (`tenant_config_version` → `tenant_kms_key` →
  `tenant`, FK-ordered), then re-throws so Cloud Tasks records the
  failure for ops visibility. Tenant `external_id` slot frees up;
  operator resubmits via `tenants.provision` with the same external_id.
- **Transient failures** (DB timeout, KMS hiccup, network blip): worker
  re-throws plainly without cleanup. Cloud Tasks retries per queue
  config. Substrate stays intact.
- **No `FAILED` state.** Adding one would require:
  (a) extending the CHECK constraint enum (migration churn),
  (b) defining transitions out of FAILED (back to PROVISIONING for
  retry? to TERMINATED for cleanup?), and
  (c) operators writing recovery scripts.
  Hard rollback is cleaner: substrate either exists fully or not at all.

The cleanup helper (`cleanupFailedProvisioning`) lives in the same
file as the worker. It is exported from `@cortex/tenant-context` and
**does NOT emit audit events** — the tenant never went public; cleanup
is internal hygiene, not a compliance event. Distinct from
`tenants.terminate` (Slice C) which DOES emit `TENANT_TERMINATED`
because terminated tenants WERE publicly active.

The cleanup helper has a **safety guard**: it refuses to clean up
tenants past `PROVISIONING` (status in {READY, ACTIVE, SUSPENDED,
OFFBOARDING, TERMINATED}). Mis-invocation throws an error pointing the
caller at `tenants.terminate`.

### 5. Audit emission — hybrid catalog (per D6)

Two emission classes:

- **Domain actions** for irreversible / compliance-relevant transitions:
  `TENANT_PROVISIONED`, `TENANT_OFFBOARDING_STARTED`, `TENANT_TERMINATED`,
  `TENANT_KEY_ROTATED`, `TENANT_CONFIG_VERSION_UPDATED`. Verbs per
  semantics (CREATE for `_PROVISIONED`, UPDATE for the others, DELETE
  for `_TERMINATED`). Compliance regulators query these by name.
- **Generic `TENANT_STATUS_CHANGED`** (verb UPDATE, with
  `before_state`/`after_state` payload) for reversible state transitions
  (SUSPEND ↔ RESUME, intermediate worker steps). The before/after
  capture the delta; readers reconstruct the timeline.

**Actor attribution:**

- Terminal-success events (e.g., `TENANT_PROVISIONED`) carry the
  **caller's actor identity** for forensic attribution. Operators
  querying "who provisioned tenant X" see the human/system that
  initiated the workflow.
- Intermediate state transitions (worker-driven advances like
  PROVISIONING → READY) carry the **service actor** `cortex-tenant-lifecycle`
  per the §4.14 hardcode pattern (AC01 swaps to a request-scoped
  resolver later).

This split keeps the audit chain forensically useful for both "who
caused this lifecycle change" (terminal events) and "what did the
system do internally" (status-change events).

---

## Rationale

**Why not synchronous provisioning?** Multi-step GCP API calls (KMS
key creation, GCS bucket prefix setup, Cloud Run service provisioning,
Cloud SQL instance allocation for Enterprise) take 30 seconds to 30
minutes end-to-end. The HTTP path that triggered the provisioning
would tie up a Cloud Run instance for the duration, and the caller
(SCR-24 Platform Ops Dashboard, W01 Onboarding Wizard) would need to
hold the connection open. Async dispatch decouples the HTTP layer
from the long-running work.

**Why not Cloud Run Jobs instead of Cloud Tasks?** Jobs are one-shot
batches; lifecycle workflows are interrupt-driven (operator triggers
a suspend, the worker fires once, ack'd). Jobs would also lose the
built-in retry + dedup that Cloud Tasks provides natively.

**Why not Pub/Sub?** Fan-out semantics (multiple subscribers per
message) are wrong for single-consumer workflows. Roadmap §4.12
tracks Pub/Sub fan-out for downstream cascades (TENANT_SUSPENDED →
S15 device pause + S17 outbound stop), but the orchestration layer
itself wants single-consumer dispatch with retry — Cloud Tasks fits.

**Why three queues, not one?** Per Q-OPEN-1: different workflows have
different SLAs and concurrency profiles. Provisioning is rare (one per
new tenant — low volume but long-running); lifecycle ops happen on
demand (suspend/resume — bursty); key rotation is scheduled
(predictable cadence). Separate queues let each get its own retry
config, concurrency cap, and dead-letter handling.

**Why hard rollback instead of FAILED state?** A FAILED state would
expand the state machine surface and require operators to know which
substrate exists vs which is partial. Hard rollback simplifies the
mental model: a tenant either fully exists or doesn't. The tradeoff is
that legitimate transient KMS / DB failures could trigger destructive
cleanup if they're miscategorized — mitigated by SA14 (only
known-unrecoverable failures trigger cleanup; transients re-throw
without).

**Why two-layer idempotency (taskId dedup + worker pre-check)?**
Cloud Tasks dedup is a 1-hour window — long retries (5 attempts ×
exponential backoff) can extend past the window. Worker pre-check
provides defense-in-depth. The pre-check cost is one DB read per
dispatch; cheap.

---

## Consequences

### Positive

- **State machine in code, not just docs.** `ALLOWED_TRANSITIONS`
  rejects illegal transitions at runtime; the DB CHECK rejects
  illegal values. F02 callers can't accidentally short-circuit the
  state model.
- **Cloud Tasks dedup + worker pre-check provides idempotency without
  distributed locks.** No Redis, no advisory-lock dance, no
  external-state-machine service. Operators retry by re-dispatching;
  duplicates are safe.
- **Audit chain captures full forensic trail.** Every lifecycle event
  is grep-able by tenant + action; SCR-20 (audit log UI) can reconstruct
  per-tenant timelines without joining multiple tables.
- **Standard + Enterprise share state machine.** Tier-branching happens
  inside worker logic (e.g., dedicated Cloud SQL allocation gated on
  `tier === 'ENTERPRISE' && dedicated_db_approved`). Adding a future
  third tier doesn't require state-machine changes.
- **Hard rollback keeps substrate consistent.** Operators reason about
  partial-provisioning recovery as "delete + retry," not "patch state
  to make it consistent."

### Negative

- **Backward-compat edge (`PROVISIONING → ACTIVE`) creates a dual-path
  tolerance window.** Tests using the direct path coexist with workflow
  code using the explicit READY-gated path. Convention doc §1 tracks
  this; future cleanup retires the direct edge once all fixtures route
  via READY.
- **Smoke-test failure triggers destructive cleanup.** Operators losing
  transient KMS access during the smoke-test window could see
  legitimate tenants cleaned up. Mitigation: smoke test is fast (<5s
  expected); KMS unavailability during this window is rare; SA14
  scoping limits cleanup to known-unrecoverable failures, not generic
  errors.
- **Three Cloud Tasks queues add operational surface.** Each needs IAM,
  monitoring, dead-letter handling. One-time setup cost; predictable
  per-queue alerts.
- **Worker pre-check is a per-dispatch DB round-trip.** Cheap, but
  non-zero. At provisioning rates this is negligible; if lifecycle
  workflows ever need 1000s/sec, worker pre-check becomes a hot path
  worth optimizing.

### Neutral

- **Cloud Run service-to-service IAM is the interim auth mechanism**
  (per planning-doc D8) until AC01 ships proper agent identities. The
  state machine and orchestration are auth-agnostic; AC01 layers on
  top.
- **`PROVISIONING_WORKER_URL` env var must be configured per env.**
  Slice A reads this from environment; Slice D ships the actual Cloud
  Run service that handles dispatched tasks. In dev, the env points at
  a local instance; in CI, an ephemeral worker; in staging/prod, a
  deployed Cloud Run service.

---

## Alternatives considered

### A. K8s Jobs

Rejected per ADR-COMPUTE-001. Cortex platform is Cloud Run, not
Kubernetes; there is no GKE control plane to orchestrate Jobs against.
Adopting K8s for lifecycle workflows alone would re-introduce the
infrastructure cost ADR-COMPUTE-001 deliberately avoided.

### B. Synchronous provisioning (HTTP holds the connection)

Rejected. Provisioning takes 5–30 minutes (Standard) or up to 30
minutes (Enterprise with dedicated Cloud SQL allocation). Cloud Run's
default request timeout is 5 minutes (extensible to 60 but not
indefinite). Holding the caller's connection through long GCP API
sequences is fragile and ties up Cloud Run instances. Async dispatch
is necessary at this latency budget.

### C. FAILED state for partial-provisioning recovery

Rejected per planning-doc SA10. A FAILED state would:

- Extend the `tenant_status_check` CHECK constraint enum (8 values
  instead of 7).
- Define transitions out of FAILED (back to PROVISIONING for retry?
  to TERMINATED for cleanup? both?).
- Require operator-written recovery scripts to disambiguate "FAILED
  in step 3" vs "FAILED in step 5."

Hard rollback (cleanupFailedProvisioning) is cleaner: substrate
either exists fully or not at all. Operator workflow is "investigate
the failure, then resubmit" — no special state to manage.

### D. Single lifecycle queue (one queue for all six workflows)

Rejected per Q-OPEN-1. Different workflows have different SLAs:

- Provisioning: rare, long-running (5–30 min), low volume.
- Suspend/resume: on-demand, fast (<10s), bursty.
- Offboard/terminate: rare, slow (minutes to hours for export
  generation), low volume.
- Key rotation: scheduled, fast, predictable cadence.

A single queue would force one retry config + concurrency cap across
all workflows. Three queues let each get its own SLA-appropriate
config.

### E. Saga pattern (persistent state machine in DB)

Deferred. A formal saga (per-step rows in a `lifecycle_workflow` table,
durable progress, compensating actions per step) would be over-
engineered for Phase 1's 1-tenant reality. Cloud Tasks dedup + worker
pre-check + hard rollback is sufficient. Roadmap entry tracks the
upgrade trigger: when concurrent provisioning becomes load-bearing
(F03+ multi-tenant scale), revisit.

### F. Cloud Workflows (GCP's workflow orchestration product)

Considered. Cloud Workflows is YAML-based step orchestration with
built-in retry/conditionals/parallelism. Rejected for two reasons:

- Adds another GCP service to operate (alerting, IAM, monitoring).
- Workflow-as-YAML has worse observability than worker-as-code (no
  TypeScript type safety, no `vitest` testability, no shared
  utilities with the rest of `@cortex/tenant-context`).

Worker-as-code in TypeScript reuses existing patterns
(`bindTenantToDbSession`, `emitAuditEvent`, the tenants namespace) and
is testable with mocked Cloud Tasks SDK calls (per SA4).

---

## References

- **Spec + planning:**
  - `docs/build-prompts/cortex_build_prompts_v3.md` §P1.2 — F02 build prompt.
  - Cortex v2.2 Spec §F02 — tenant lifecycle requirements.
  - `docs/planning/f02-tenant-lifecycle-scope.md` — D1–D12 + Q-OPEN-1 through Q-OPEN-6 + SA1–SA15 with full per-decision rationale.
- **Companion ADRs:**
  - ADR-COMPUTE-001 (Cloud Run service-per-tenant for ENTERPRISE — branched inside the worker).
  - ADR-INFRA-007 (per-tenant CMEK substrate-now / real-impl-later — same shape as the F02 stub swaps).
  - ADR-AU-001 (audit emission verb diversity — D6 hybrid catalog).
  - ADR-DB-002 (RLS baseline — `tenant_kms_key` + `tenant_config_version` policies).
  - ADR-INFRA-006 (WIF identity layer — D8 Cloud Run service-to-service IAM).
- **Substrate:**
  - `services/foundation/migrations/0010_tenant_lifecycle_metadata.sql` — `tenant.status` enum extension + 5 lifecycle metadata columns.
- **Slice A implementation:**
  - `packages/tenant-context/src/tenants.ts` — `tenants.provision()` (sync-enqueue half).
  - `packages/tenant-context/src/provisioning-worker.ts` — worker entry point + `cleanupFailedProvisioning`.
  - `packages/tenant-context/src/cloud-tasks.ts` — Cloud Tasks dispatch utility.
  - `packages/tenant-context/src/audit-actions.ts` — catalog with 5 new F02 actions.
- **Convention:**
  - `docs/architecture/tenant-lifecycle-convention.md` (lands sub-phases 7.2–7.3) — operational patterns + state-machine details + workflow-by-workflow guides.
- **Roadmap:**
  - §1.1 (per-tenant CMEK trigger criteria), §4.12 (Pub/Sub fan-out for downstream cascades, deferred), §4.14 (AC01 actor swap), §10.4 (DB client abstraction), §10.11 (HTTP framework choice), §10.12 (tenant CRUD authz).

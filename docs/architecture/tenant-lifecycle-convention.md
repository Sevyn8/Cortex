# Tenant Lifecycle Convention

Pattern reference for any module driving the F02 lifecycle state machine
or extending it (provisioning, suspension, offboarding, termination,
key rotation). Read before writing lifecycle workflow code, worker
functions, or operator runbooks.

Companion documents: ADR-LIFECYCLE-001 (state machine + Cloud Tasks
orchestration), ADR-COMPUTE-001 (Cloud Run placement model),
ADR-INFRA-007 (per-tenant CMEK substrate), ADR-AU-001 (audit emission),
ADR-DB-002 (RLS baseline), `docs/planning/f02-tenant-lifecycle-scope.md`
(D1–D12 + Q-OPEN-1 through Q-OPEN-6 + SA1–SA15).

**Slice scope.** This doc evolves with the F02 slices. Sections tagged
`[F02-A]` are authoritative as of Slice A (provisioning). Sections
tagged `[F02-B]`, `[F02-C]`, `[F02-D]` are placeholder/skeletal until
the corresponding slice ships and fills them in. Untagged sections are
stable across slices.

## Section index

1. State machine (transitions, dual-path tolerance)
2. Cloud Tasks orchestration (three queues, retry config, dead-letter)
3. RLS bind requirements (when, why, fail-closed behavior)
4. Provisioning workflow `[F02-A]`
5. Suspension cascade `[F02-B]`
6. Offboarding + termination + legal hold `[F02-C]`
7. Key rotation + dual-key overlap `[F02-D]`
8. Operational patterns (retry, idempotency, manual cleanup, dead-letter)
9. Audit emission patterns (hybrid catalog usage, actor attribution)
10. Future swaps (IC01 vertical seed, W01 admin invite, AC01 session
    revoke, per-record legal hold, auto Cloud SQL approval)

Appendix A — Phase 1 → F02 swap paths (absorbed from
`f02-swap-paths-for-slice-c-resolvers.md` per planning doc D11; lands
in sub-phase 7.3).

---

## 1. State machine

The tenant lifecycle is a 7-state machine. The DB CHECK constraint
(`tenant_status_check` per migration 0010) is the value-set guard;
the `ALLOWED_TRANSITIONS` map in
`packages/tenant-context/src/tenants.ts` is the transition guard.
Both must stay in sync — migration 0010 + the code change in
`tenants.ts:ALLOWED_TRANSITIONS` landed in the same Slice A commit
to enforce this invariant.

### 1.1. State diagram

```
        REQUESTED
            │
            │  (worker advances; ENTERPRISE first awaits
            │   `dedicated_db_approved=true` per Q-OPEN-6)
            ▼
        PROVISIONING
            │
            │  (worker; substrate smoke-test passes)
            ▼
         READY  ◄──── (SA12 backward-compat edge ▼)
            │                                    │
            │  (smoke-test gate; SA5)            │
            ▼                                    │
         ACTIVE ◄────────────────────────────────┘
         ▲    │
         │    │  (operator suspend)
  resume │    ▼
         │  SUSPENDED
         │    │
         └────┤  (operator offboard from either ACTIVE or SUSPENDED)
              ▼
        OFFBOARDING
              │
              │  (grace period elapsed; operator confirm)
              ▼
        TERMINATED  (terminal — no transitions out)
```

### 1.2. State semantics

| State          | Meaning                                                                                                  | Tenant capabilities                                                                                            | Set by                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `REQUESTED`    | Provisioning kickoff awaited. ENTERPRISE additionally awaits `dedicated_db_approved=true`.               | None — substrate exists but worker hasn't run.                                                                 | `tenants.provision` (initial INSERT for ENTERPRISE).                                         |
| `PROVISIONING` | In-flight pipeline. Worker is running through KMS / GCS / Cloud SQL / control plane.                     | None — substrate partial.                                                                                      | `tenants.provision` (initial INSERT for STANDARD); worker advances ENTERPRISE post-approval. |
| `READY`        | Provisioning success. Smoke test passed. Substrate complete.                                             | Reads + writes possible at the DB level, but routing layer (Slice D HTTP API) treats READY as "internal-only." | Worker after `runSmokeTest`.                                                                 |
| `ACTIVE`       | Live and serving traffic. Routing layer accepts requests.                                                | Full read/write.                                                                                               | Worker (post-READY transition).                                                              |
| `SUSPENDED`    | Write-blocked; reads allowed; scheduled jobs halted. Data-export still works.                            | Reads only (data export, audit queries). Writes raise `TenantSuspendedError` at the application layer.         | `tenants.suspend` `[F02-B]`.                                                                 |
| `OFFBOARDING`  | Export archive generation in progress; grace period running. Tenant cannot be promoted back to ACTIVE.   | Same as SUSPENDED + export archive available.                                                                  | `tenants.offboard` `[F02-C]`.                                                                |
| `TERMINATED`   | Hard-deleted. Substrate removed; KMS key tombstoned. Post-termination queries return `tenant-not-found`. | None.                                                                                                          | `tenants.terminate` `[F02-C]`.                                                               |

### 1.3. Allowed transitions

The `ALLOWED_TRANSITIONS` map in `tenants.ts`:

```typescript
new Map([
  ['REQUESTED', ['PROVISIONING']],
  ['PROVISIONING', ['READY', 'ACTIVE']], // 'ACTIVE' = backward-compat edge
  ['READY', ['ACTIVE']],
  ['ACTIVE', ['SUSPENDED', 'OFFBOARDING', 'TERMINATED']],
  ['SUSPENDED', ['ACTIVE', 'OFFBOARDING', 'TERMINATED']],
  ['OFFBOARDING', ['TERMINATED']],
  ['TERMINATED', []],
]);
```

`tenants.setStatus(db, id, next, ctx)` validates against this map.
Illegal transitions raise `TenantStatusError` with the current state
and the allowed-next-states list — the error message is operator-
useful ("tenant X is in PROVISIONING; allowed next: READY, ACTIVE").

### 1.4. Dual-path tolerance — `PROVISIONING → ACTIVE` backward-compat

The `PROVISIONING → ACTIVE` edge is retained alongside the explicit
`PROVISIONING → READY → ACTIVE` path per planning-doc SA12 Option a.
Reasons:

- Slice A's existing 15 `tenants.create` test fixtures use the direct
  path — they predate the F02 state machine.
- Bootstrap scripts (P0.9 super-admin bootstrap) advance the
  bootstrap-tenant directly to ACTIVE without running the full
  provisioning workflow.

**F02 provisioning workflow (Slice A worker)** uses the explicit
`PROVISIONING → READY → ACTIVE` path. Smoke test gates the READY →
ACTIVE flip per SA5.

**Retirement plan.** Once all callers route through the explicit path
(target: post-Slice-D when HTTP API is the operator interface, OR
when test fixtures are migrated), a future cleanup commit removes
`'ACTIVE'` from `PROVISIONING`'s allowed-next list. The DB CHECK
constraint stays unchanged (still permits all 7 values) — only the
in-code transition guard tightens.

### 1.5. Where transitions happen

| Transition                      | Caller                                               | Mechanism                                                                      |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| (initial INSERT) → REQUESTED    | `tenants.provision` (ENTERPRISE)                     | INSERT with `initialStatus='REQUESTED'`.                                       |
| (initial INSERT) → PROVISIONING | `tenants.provision` (STANDARD)                       | INSERT with `initialStatus='PROVISIONING'`. Or `tenants.create` (DB default).  |
| REQUESTED → PROVISIONING        | `provisioningWorker` post-approval                   | `tenants.setStatus(db, id, 'PROVISIONING', {actor: cortex-tenant-lifecycle})`. |
| PROVISIONING → READY            | `provisioningWorker` after smoke-test pass           | Same.                                                                          |
| PROVISIONING → ACTIVE           | (backward-compat — tests + bootstrap)                | `tenants.setStatus`.                                                           |
| READY → ACTIVE                  | `provisioningWorker` after `TENANT_PROVISIONED` emit | Same.                                                                          |
| ACTIVE → SUSPENDED              | `tenants.suspend` `[F02-B]`                          | TBD.                                                                           |
| SUSPENDED → ACTIVE              | `tenants.resume` `[F02-B]`                           | TBD.                                                                           |
| ACTIVE → OFFBOARDING            | `tenants.offboard` `[F02-C]`                         | TBD.                                                                           |
| SUSPENDED → OFFBOARDING         | `tenants.offboard` `[F02-C]`                         | TBD.                                                                           |
| ACTIVE → TERMINATED             | (legacy — operator escape hatch)                     | `tenants.setStatus`. Generally goes through OFFBOARDING.                       |
| SUSPENDED → TERMINATED          | (legacy — operator escape hatch)                     | Same.                                                                          |
| OFFBOARDING → TERMINATED        | `tenants.terminate` `[F02-C]`                        | TBD.                                                                           |

### 1.6. Read-after-write semantics

Status-update and audit-emit happen in the same `db.transaction` so
audit consumers see consistent state. A reader querying
`tenant.status` immediately after `tenants.setStatus` returns sees the
new state AND the corresponding `TENANT_STATUS_CHANGED` audit row in
the same snapshot.

For Cloud Tasks workflows (multi-step), each step runs in its own
transaction. Between steps, intermediate reads see committed state
from prior steps. The SA11 worker pre-check leverages this — the
worker reads `tenant.status` at dispatch time and decides whether to
advance based on committed state.

---

## 2. Cloud Tasks orchestration

Per ADR-LIFECYCLE-001 + planning-doc Q-OPEN-1, all six lifecycle
workflows are dispatched via Google Cloud Tasks. Three queues with
distinct SLAs.

### 2.1. The three queues

| Queue                | Verbs                                                            | Slice         |
| -------------------- | ---------------------------------------------------------------- | ------------- |
| `provisioning-queue` | `provisioning-{tenant_id}`                                       | Slice A.      |
| `lifecycle-queue`    | `suspend-{id}`, `resume-{id}`, `offboard-{id}`, `terminate-{id}` | Slices B + C. |
| `key-rotation-queue` | `rotate-keys-{id}`                                               | Slice D.      |

Why three: provisioning is rare and long-running (5–30 min); lifecycle
ops are bursty and fast (<10s for suspend/resume); key rotation is
scheduled and predictable. Separate queues let each get its own SLA-
appropriate retry config + concurrency cap. A single shared queue
would force one set of values across mismatched workloads.

### 2.2. Per-queue config

| Setting         | Value                                   | Source                                                                             |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| Max attempts    | 5                                       | Q-OPEN-1.                                                                          |
| Backoff         | Exponential: 30s → 5min cap → 30min cap | Q-OPEN-1.                                                                          |
| Concurrency cap | 10 concurrent dispatches                | Q-OPEN-1 (each provisioning is 5–30 min; >10 risks DB connection-pool exhaustion). |
| Dispatch rate   | 10/sec                                  | Cloud Tasks default.                                                               |
| Dedup window    | ~1 hour                                 | Cloud Tasks `taskId` built-in.                                                     |

Override only when a workflow's SLA materially differs (e.g., a future
batch-eviction workflow may want higher concurrency).

### 2.3. `taskId` pattern

Format: `{verb}-{tenant_id}` per planning-doc D5.

Examples:

- `provisioning-{uuid}` — `tenants.provision`
- `suspend-{uuid}` — `tenants.suspend`
- `terminate-{uuid}` — `tenants.terminate`
- `rotate-keys-{uuid}` — `tenants.rotateKeys`

**Why this format:**

- **Operator grep-able.** `gcloud tasks list --queue=provisioning-queue` filtered by `taskId LIKE 'provisioning-%'` surfaces all in-flight + recently-completed provisionings.
- **Built-in dedup.** Cloud Tasks rejects duplicate `taskId`s within ~1h. Re-dispatching the same workflow for the same tenant is a no-op at the queue layer, complementing the worker pre-check (SA11 layer 2).
- **One workflow per tenant per verb.** A given tenant can have at most one in-flight `provisioning` task; the operator can't accidentally race two provisionings against the same `external_id`.

### 2.4. Worker invocation

Cloud Tasks dispatches HTTP POST to a Cloud Run service. Each verb has
its own worker function (Slice A: `provisioningWorker`); future verbs
add their own files following the same shape:

```typescript
export async function provisioningWorker(
  db: NodePgDatabase<Record<string, never>>,
  payload: ProvisioningTaskPayload,
): Promise<void>;
```

**Worker URL.** Resolved per env from environment variables:

- `PROVISIONING_WORKER_URL` — Slice A.
- `LIFECYCLE_WORKER_URL` — Slices B + C.
- `KEY_ROTATION_WORKER_URL` — Slice D.

In dev, these point at a local instance. In CI, an ephemeral worker
(or the worker function is invoked directly per SA4 — SDK dispatch is
mocked). In staging/prod, deployed Cloud Run services.

**Auth.** Cloud Run service-to-service IAM (per planning-doc D8;
interim until AC01). Cloud Tasks dispatcher needs `roles/run.invoker`
on the worker's Cloud Run service.

### 2.5. Worker payload structure

```typescript
interface ProvisioningTaskPayload {
  tenantId: string; // UUID
  actorType: 'service' | 'user' | 'system';
  actorId: string;
  actorDescription?: string;
}
```

**Why caller actor metadata flows through the payload.** Forensic
attribution (per audit-emission rules in §9). Terminal-success events
(`TENANT_PROVISIONED`) carry the caller's actor identity, not the
service-actor `cortex-tenant-lifecycle`. Operators querying "who
provisioned tenant X" see the human/system that initiated the
workflow, not the worker that ran it.

The payload is base64-encoded JSON in the request body (Cloud Tasks
SDK convention). Body decode happens at the worker entry point;
payload validation should be strict (zod schema; future).

### 2.6. Dead-letter handling

After max attempts (5 per queue), Cloud Tasks marks the task
permanently failed and (when configured) dispatches to a dead-letter
queue. Dead-letter queue is a separate Cloud Tasks queue with no
retry; the operator's intervention surface.

**Operator alert.** Cloud Monitoring alert on `cloudtasks.googleapis.com/queue/dead_letter_count`

> 0. P0.6 observability hooks supply the alerting infrastructure;
>    F02 only declares the dead-letter queue + alert config (Slice D TF).

**Manual recovery shape.**

1. Read the dead-letter task's payload (gcloud or Cloud Console).
2. Read the tenant's current status via `tenants.get`.
3. Decide: (a) substrate inconsistent → run `cleanupFailedProvisioning`
   - operator resubmit; (b) transient cause unresolved → wait + manually
     re-dispatch (`gcloud tasks create-http-task`); (c) tenant should not
     exist → `cleanupFailedProvisioning`.

### 2.7. Re-enqueue on Enterprise approval flip (SA13)

Enterprise tenants land at `REQUESTED` and stay there until
`dedicated_db_approved=true` is flipped. The initial dispatch from
`tenants.provision` does fire, but the worker no-ops on
`dedicated_db_approved=false` and returns success.

When an operator flips the flag (Slice D HTTP endpoint;
intermediate Slice A pattern: direct DB UPDATE via psql or SQL
console), the **approval HTTP endpoint** calls `dispatchCloudTask`
directly to re-enqueue the workflow. Worker is then invoked again,
sees `dedicated_db_approved=true` + `status=REQUESTED`, and advances.

This pattern is per planning-doc SA13 Option A. Convention is
event-driven re-enqueue (push) rather than periodic polling (pull) or
worker self-rescheduling.

---

## 3. RLS bind requirements

Several tables touched by lifecycle workflows are RLS-protected. The
bind primitive must be invoked correctly, or worker / resolver code
fails in confusing ways.

### 3.1. RLS-protected tables

| Table                   | RLS policy               | Used by                                                                                                                |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `tenant_kms_key`        | FOR ALL (migration 0009) | `getKeyForTenant` reads; `tenants.create` writes; `cleanupFailedProvisioning` writes.                                  |
| `tenant_config_version` | FOR ALL (migration 0007) | `getQuotaConfig` reads (when ctx supplies tenantId + db); `tenants.create` writes; `cleanupFailedProvisioning` writes. |
| `tenant_quota_usage`    | FOR ALL (migration 0007) | `checkQuota` reads + writes (Slice C consumer).                                                                        |
| `audit_event`           | FOR ALL (migration 0004) | `emitAuditEvent` writes.                                                                                               |

**Tables WITHOUT RLS** (control plane):

- `tenant` — the registry table. Reads + writes don't need bind.
  Worker reads `tenant.status` / `tenant.tier` / `tenant.dedicated_db_approved`
  freely. `tenants.create` / `tenants.setStatus` / `cleanupFailedProvisioning`
  write directly.

### 3.2. Bind primitive

```typescript
import { bindTenantToDbSession } from '@cortex/tenant-context';

await db.transaction(async (tx) => {
  await bindTenantToDbSession(tx, tenantId);
  // tx is now bound; all RLS-protected reads/writes use tenantId
  // for policy evaluation
});
```

**Mechanism.** `bindTenantToDbSession` runs `SELECT set_config('app.tenant_id', $1, true)`.
The `true` parameter is `is_local` — equivalent to `SET LOCAL` —
binding the value to the current transaction. **Outside a transaction,
SET LOCAL silently no-ops** (Postgres doesn't error; the value isn't
stored). This is the single biggest gotcha (see §3.6).

### 3.3. When binding is required

**Any operation that touches an RLS-protected table — read OR write.**
RLS evaluates the policy on every row access. Without bind:

- **Reads** return 0 rows (the policy's USING clause evaluates and
  hides the row from the query). Surfaces as "row not found" or
  empty result set in application code.
- **Writes** raise SQLSTATE `42501` (`insufficient_privilege`). Surfaces
  as `AuditEventEmissionError` for audit_event INSERTs, or generic
  pg.DatabaseError for other tables.

### 3.4. Fail-closed behavior of `cortex.current_tenant_id()`

Per ADR-DB-002, `cortex.current_tenant_id()` (the function the RLS
policies call) is **fail-closed**. When `app.tenant_id` is NULL or
empty, the function `RAISE EXCEPTION` rather than returning NULL.

Surfaces as a raw DB error with message **"app.tenant_id is not set"**
or **"cortex.current_tenant_id: app.tenant_id is not set"**. Operators
grep for either pattern.

This means RLS predicates evaluate against a raised exception, not
against a falsy value. The error bubbles up through Drizzle as a
generic `pg.DatabaseError`, not as an empty result set.

The encryption RLS test exercises this exact path: when bind is missing
on an `encryptForTenant` call, `getKeyForTenant`'s tenant_kms_key SELECT
fails with this error before either the "0 rows → TenantKmsKeyNotFoundError"
branch or the audit-emit's 42501 path.

### 3.5. Caller responsibility

Resolvers (`getKeyForTenant`, `getQuotaConfig`, `getComputePlacement`)
and worker functions **don't bind themselves**. The caller's
transaction may already have its own session-bound state, and a
resolver-side bind would over-bind the txn.

**Pattern:**

```typescript
// Caller binds.
await db.transaction(async (tx) => {
  await bindTenantToDbSession(tx, tenantId);
  // Then calls into resolvers / workers / emit.
  const keyResource = await getKeyForTenant(tx, tenantId);
  await emitAuditEvent(tx, {...});
});
```

The worker function (`provisioningWorker`) DOES bind explicitly inside
its sub-transactions because the worker's outer entry point doesn't
have a parent transaction — Cloud Tasks dispatches an HTTP POST and
the handler is responsible for opening DB transactions.

### 3.6. Common gotchas

1. **Forgetting bind in tests.** Surfaces as `TenantKmsKeyNotFoundError`
   (the row is hidden by RLS) or "app.tenant_id is not set" (resolver
   hits cortex.current_tenant_id() before the row check).
2. **Binding the wrong tenantId.** RLS policy succeeds — but reads
   the WRONG tenant's row. Subtle bugs; no error surfaced. Mitigation:
   tests should always assert on tenant attribution (e.g., `expect(row.id).toBe(expectedId)`).
3. **`bindTenantToDbSession` outside a transaction.** Silently no-ops
   because `SET LOCAL` has no effect outside a txn. Surfaces as fail-
   closed RLS errors at the FIRST operation. Mitigation: always wrap
   in `db.transaction(...)`.
4. **Re-binding inside a nested transaction.** Drizzle's nested
   transactions are SAVEPOINTs in the same physical txn — the bind
   from the outer scope persists. Re-binding in an inner scope works
   but is usually unnecessary.
5. **Querying `tenant_config_version` for the LATEST version under
   RLS.** The `ORDER BY desc(version_number) LIMIT 1` works fine
   because the policy still evaluates per row; rows for other tenants
   are hidden, so the "latest" is correctly scoped. No special handling
   needed.

### 3.7. Helpers

Three helpers exported from `@cortex/tenant-context`:

- **`bindTenantToDbSession(db, tenantId)`** — explicit bind inside an
  open transaction. Caller passes the tenantId. Caller manages the
  transaction lifecycle. Use when composing inside an existing
  `db.transaction(async (tx) => {...})` block.
- **`ensureBoundToTenant(db)`** — convenience wrapper that reads the
  current async-local context via `getTenantOrThrow()` and binds
  using that. Throws `TenantContextMissingError` if no async context
  is set. Same transaction-scoping requirement as
  `bindTenantToDbSession`. Use inside HTTP middleware or framework
  adapters that have already bound the async-local context but not
  the DB session.
- **`withTenantDbClient(pool, tenantId, callback)`** — scope-bound
  factory (per planning-doc §10.4 forcing function + SA16). Acquires
  a connection from the pool, opens a transaction, binds the
  tenantId, runs `callback(tx)`, commits on resolve / rollback on
  throw, releases the connection. **Use this when the caller doesn't
  already have a transaction open** — typical Slice D HTTP-handler
  pattern: `const tenant = await withTenantDbClient(pool, tenantId,
async (tx) => tenants.get(tx, tenantId));`. Forgetting to bind is
  impossible at call sites that compose around this helper.

`bindTenantToDbSession` and `ensureBoundToTenant` run
`set_config('app.tenant_id', $1, true)` under the hood; neither does
anything else with the connection. Choose by call-site ergonomics —
they have identical effect on the txn.

`withTenantDbClient` validates the tenantId BEFORE acquiring a
connection (fail-fast on bad input; no wasted pool connection on
validation errors).

---

## 4. Provisioning workflow `[F02-A]`

The end-to-end flow that takes a tenant from "operator clicked
provision" through "ACTIVE and serving traffic." Two tier branches
(STANDARD vs ENTERPRISE); both share the same state machine + audit
emission shape. Implementation lives in `tenants.provision()`
(sync-enqueue half) + `provisioningWorker()` (async workflow half).

### 4.1. Standard tier flow

Sequence (per `packages/tenant-context/src/tenants.ts:provision` +
`provisioning-worker.ts:provisioningWorker`):

1. **Caller** invokes `tenants.provision(db, input, ctx)` with
   `input.tier = 'STANDARD'`. `tenants.provision` decides
   `initialStatus = 'PROVISIONING'` (Standard skips REQUESTED — the
   approval gate is Enterprise-only per Q-OPEN-6).
2. **`tenants.provision` calls `tenants.create(db, {...input, initialStatus: 'PROVISIONING'}, ctx)`**
   inside a single `db.transaction`. Substrate written:
   - INSERT into `tenant` (control plane; no RLS).
   - `bindTenantToDbSession(tx, row.id)` for subsequent RLS-protected writes.
   - INSERT into `tenant_kms_key` with the env's `cortex-general-key` resource name (resolved via `buildKeyResourceName`). RLS-bound.
   - (optional) INSERT into `tenant_config_version` v=1 if `input.initialConfig` was supplied (Q-OPEN-4: Phase 1 IC01 vertical-package seed is a stub — empty `{}` config or whatever caller passes).
3. **`tenants.create` emits the substrate audit chain** (caller actor):
   - `TENANT_CREATED` (verb CREATE) with `after_state` capturing the tenant row shape.
   - `TENANT_KMS_KEY_BOUND` (verb CREATE) with `after_state.kms_key_resource_name`.
   - (optional) `TENANT_CONFIG_VERSION_CREATED` (verb CREATE) if v=1 was inserted.
4. **`tenants.provision` returns synchronously** with `{tenantId, status: 'PROVISIONING'}` after the transaction commits. Caller polls `tenants.get(db, tenantId).status` for progress.
5. **`tenants.provision` enqueues a Cloud Task** to `provisioning-queue` with `taskId='provisioning-{tenantId}'` and payload `{tenantId, actorType, actorId, actorDescription?}` (caller actor for forensic attribution). HTTP target: `PROVISIONING_WORKER_URL` env.
6. **Cloud Tasks dispatches** (HTTP POST). `provisioningWorker(db, payload)` runs.
7. **Worker pre-check (SA11):** reads `(status, tier, dedicated_db_approved)` for the tenant. Standard tenants start at `PROVISIONING` — pre-check passes.
8. **Worker advances PROVISIONING → READY** via `tenants.setStatus(db, tenantId, 'READY', {actor: cortex-tenant-lifecycle})`. Emits `TENANT_STATUS_CHANGED` (UPDATE; service actor).
9. **Worker runs smoke test** (`runSmokeTest`, see §4.3). Pass: continue. Fail: rollback (see §4.4).
10. **Worker emits `TENANT_PROVISIONED`** (CREATE; **caller actor preserved** from the payload — terminal-success event per §9 actor attribution rules). `after_state.status = 'READY'`.
11. **Worker advances READY → ACTIVE** via `tenants.setStatus(db, tenantId, 'ACTIVE', {actor: cortex-tenant-lifecycle})`. Emits `TENANT_STATUS_CHANGED`. Tenant is now serving traffic.
12. **Worker returns** (Cloud Tasks ack).

### 4.2. Enterprise tier flow

Same as Standard except for the approval gate at the start.

1. **Caller** invokes `tenants.provision(db, input, ctx)` with
   `input.tier = 'ENTERPRISE'`. `tenants.provision` decides
   `initialStatus = 'REQUESTED'` (Q-OPEN-6 manual approval).
2. **`tenants.create`** inserts `tenant` row with `status = 'REQUESTED'`
   and `dedicated_db_approved = false` (DB default). Same substrate
   audit chain as Standard.
3. **`tenants.provision` enqueues** the Cloud Task. The task fires,
   but...
4. **Worker pre-check** sees `(status='REQUESTED', tier='ENTERPRISE',
dedicated_db_approved=false)` and **no-ops** (returns without
   advancing). Cloud Tasks treats the worker's success-return as
   "task completed."
5. **Tenant stays at REQUESTED** until an operator approves. See
   §4.6 for the operator workflow.
6. **Once approved + re-enqueued**, the worker pre-check sees
   `(status='REQUESTED', tier='ENTERPRISE', dedicated_db_approved=true)`
   and **advances REQUESTED → PROVISIONING** (`TENANT_STATUS_CHANGED`).
   From this point the flow matches Standard's steps 8–12.

Future (`[F02-D]`): Enterprise provisioning between PROVISIONING and
READY adds dedicated Cloud SQL allocation (per ADR-INFRA-005 +
ADR-COMPUTE-001). Current Slice A: `dedicated_db_approved=true` is
the gate, but the actual Cloud SQL allocation step is a forward
spec; Slice A's smoke test does not yet check the dedicated instance.

### 4.3. Smoke test (substrate verification per SA8)

Worker calls `runSmokeTest(db, tenantId)` after advancing to
PROVISIONING. The test verifies substrate exists for downstream
operations:

```typescript
// 1. Tenant row exists (no RLS — control plane).
const tenantRow = await db.select().from(tenant).where(eq(tenant.id, tenantId)).limit(1);
if (tenantRow.length === 0) return false;

// 2. tenant_kms_key row exists (RLS-bound read).
return db.transaction(async (tx) => {
  await bindTenantToDbSession(tx, tenantId);
  const kmsRows = await tx
    .select({ id: tenantKmsKey.id })
    .from(tenantKmsKey)
    .where(eq(tenantKmsKey.tenant_id, tenantId))
    .limit(1);
  return kmsRows.length > 0;
});
```

**Pass:** both checks return rows. Worker advances state.

**Fail:** any check returns no rows. Worker invokes
`cleanupFailedProvisioning` (see §4.4) and re-throws — Cloud Tasks
records the failure for ops.

**Slice A scope:** 2 substrate-presence checks. `tenant_config_version`
v=1 absence is treated as OK (the row is optional — only present when
`initialConfig` was supplied to `tenants.create`). Future expansions:
KMS key reachability ping, GCS prefix HEAD, Cloud SQL connection probe
for ENTERPRISE per ADR-INFRA-005 + spec §1 acceptance criterion 3.

The smoke test is fast (<5 s expected) by design — SA14's
"smoke-test failure triggers cleanup" only works cleanly when the
test runs faster than the typical KMS hiccup window.

### 4.4. Rollback semantics (SA10 + SA14)

**Trigger:** smoke-test failure ONLY (per SA14). Transient errors
(DB timeout, KMS hiccup, network blip) re-throw without cleanup so
Cloud Tasks retries cleanly.

**`cleanupFailedProvisioning(db, tenantId)`** (in `provisioning-worker.ts`):

1. **Read current `tenant.status`.** If row missing → no-op (idempotent).
   If `status` past PROVISIONING (READY/ACTIVE/SUSPENDED/OFFBOARDING/TERMINATED)
   → throw with message pointing to `tenants.terminate`. Safety guard.
2. **`bindTenantToDbSession(tx, tenantId)`** for the FOR-ALL-RLS deletes.
3. **DELETE in FK-ordered sequence** (FK ON DELETE RESTRICT requires
   children-first):
   - `DELETE FROM tenant_config_version WHERE tenant_id = $1`
   - `DELETE FROM tenant_kms_key WHERE tenant_id = $1`
   - `DELETE FROM tenant WHERE id = $1`
4. **No audit emission.** Per planning-doc SA10: cleanup is internal
   hygiene, not a compliance event. The tenant never went public
   (didn't reach READY); cleaning up its partial substrate doesn't
   warrant a `TENANT_TERMINATED` row. (Distinct from `tenants.terminate`
   in Slice C — that DOES emit because the tenant WAS publicly active.)

After cleanup, the `external_id` slot is freed. Operator resubmits
via `tenants.provision` with the same `external_id`. The previous
TENANT_CREATED audit row persists (audit_event is append-only per
ADR-DB-003); operators can correlate via `external_id` if forensic
trace is needed.

### 4.5. Idempotency primitives (SA11)

Two-layer defense:

| Layer                         | Mechanism                                                      | Window       |
| ----------------------------- | -------------------------------------------------------------- | ------------ |
| 1. Cloud Tasks `taskId` dedup | `taskId='provisioning-{tenantId}'` rejects duplicate enqueues  | ~1 hour      |
| 2. Worker pre-check           | Worker reads `tenant.status`; bails early if past PROVISIONING | per dispatch |

Concrete pattern in `provisioningWorker`:

```typescript
const initial = await readTenantState(db, tenantId);
if (initial === null) return; // tenant doesn't exist (post-cleanup)
if (initial.status !== 'REQUESTED' && initial.status !== 'PROVISIONING') {
  return; // already advanced; idempotent no-op
}
```

A worker re-invocation against a tenant already at `READY` /
`ACTIVE` / `SUSPENDED` / `OFFBOARDING` / `TERMINATED` is a safe
no-op. No state corruption. No duplicate audit emissions.

### 4.6. Operator workflow for Enterprise approval gate (Q-OPEN-6 + SA13)

Per planning-doc SA13 Option A — push-style re-enqueue.

1. **Operator triggers approval.** Slice D ships an HTTP API
   endpoint (`POST /v1/tenants/{id}/approve-dedicated-db`); pre-Slice-D,
   the operator's workflow is direct DB UPDATE via `psql` or SQL
   console.
2. **Approval endpoint (or operator) UPDATEs**
   `tenant.dedicated_db_approved = true` for the target tenant. No
   audit emission for this step in Slice A — the audit policy for
   approval flips lands in Slice D alongside the HTTP endpoint.
3. **Approval endpoint (or operator) calls `dispatchCloudTask`** to
   re-enqueue: `{queueName: 'provisioning-queue', taskId: 'provisioning-{tenantId}', ...}`.
4. **Cloud Tasks dispatches** (HTTP POST). Worker re-runs.
5. **Worker pre-check** sees the approved flag + REQUESTED status,
   advances normally (REQUESTED → PROVISIONING → READY → ACTIVE).

**Operator visibility:** `gcloud tasks list --queue=provisioning-queue`
shows the queued task. After dispatch, `tenants.get(db, tenantId).status`
progresses through the state machine.

**Cloud Tasks dedup caveat.** If a previous (unmet-approval) dispatch
is still within the 1-hour dedup window, the new dispatch may be
silently absorbed by Cloud Tasks. Operator visibility: query the
queue state to confirm at least one task is present. Worst case:
operator waits out the dedup window (1h) and re-dispatches.

### 4.7. Forensic queries (operator runbook)

| Query                                                                                                                                                                                                        | Purpose                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SELECT * FROM audit_event WHERE tenant_id = $1 AND action LIKE 'TENANT_%' ORDER BY occurred_at`                                                                                                             | Full lifecycle history for tenant X.                                                                                                                    |
| `SELECT (e2.occurred_at - e1.occurred_at) FROM audit_event e1, audit_event e2 WHERE e1.tenant_id = e2.tenant_id AND e1.tenant_id = $1 AND e1.action = 'TENANT_CREATED' AND e2.action = 'TENANT_PROVISIONED'` | Provisioning duration (caller-clicked-provision to TENANT_PROVISIONED).                                                                                 |
| `SELECT tenant_id FROM audit_event WHERE action = 'TENANT_CREATED' AND tenant_id NOT IN (SELECT tenant_id FROM tenant)`                                                                                      | Failed provisioning attempts (TENANT_CREATED audit row exists but tenant row is gone — cleanup ran).                                                    |
| `SELECT tenant_id FROM audit_event WHERE action = 'TENANT_CREATED' AND tenant_id NOT IN (SELECT tenant_id FROM audit_event WHERE action = 'TENANT_PROVISIONED')`                                             | In-flight or failed provisionings (CREATED but no PROVISIONED yet — could be normal in-flight or a stuck workflow). Cross-reference with tenant.status. |

**Note on append-only audit chain.** `cleanupFailedProvisioning` does
not emit, but it also does not delete prior audit rows (ADR-DB-003:
`audit_event` is append-only via BEFORE INSERT/UPDATE/DELETE trigger
raising 2F002). A failed provisioning leaves TENANT_CREATED +
TENANT_KMS_KEY_BOUND in the chain forever, with no corresponding
TENANT_PROVISIONED — this is the recommended forensic signature for
"a tenant tried to provision and was cleaned up."

## 5. Suspension cascade `[F02-B]`

The reversible-status surface that pauses a tenant without destroying
substrate. Two operator-facing entry points (`tenants.suspend` /
`tenants.resume`); one new domain action (`TENANT_SUSPENDED`) +
reuse of the generic `TENANT_STATUS_CHANGED`. Implementation lives
in `packages/tenant-context/src/tenants.ts:685` (suspend) and `:769`
(resume); contention semantics verified by §10.15 tests in
`packages/tenant-context/test/suspend-resume.spec.ts`.

**Asymmetric audit emission** is the structural decision Slice B
locks: suspend emits a dedicated domain action because it carries
_downstream consequences_ that consumers will subscribe to (session
revoke, device pause, outbound drain); resume emits the generic
`TENANT_STATUS_CHANGED` because the inverse transition has no
downstream consumers — restoring normal state restores normal
behavior, no separate cascade. Per planning-doc SB1 + Q-OPEN-2.

### 5.1. Suspension workflow (ACTIVE → SUSPENDED)

Sequence (per `tenants.ts:685` `suspend`):

1. **Caller** invokes `tenants.suspend(db, id, reason, ctx)`. Inputs:
   - `id`: tenant UUID. Validated via `idSchema` → `TenantValidationError`
     on malformed input.
   - `reason`: free-form string, **1–500 chars, required** (Q-NEW-1).
     Validated via `suspendReasonSchema` → `TenantValidationError` on
     empty/oversize.
   - `ctx.actor`: caller's actor identity. Validated via `actorSchema`.
2. **Single transaction opens.** `db.transaction(async (tx) => {...})`.
   `bindTenantToDbSession(tx, parsedId)` binds `app.tenant_id` so the
   subsequent `audit_event` INSERT passes RLS write policy.
3. **Pessimistic row lock.** `SELECT ... FROM tenant WHERE id = $1
FOR UPDATE LIMIT 1` — acquires an exclusive row lock that serializes
   against any concurrent suspend / resume / setStatus / update on the
   same tenant (§5.5).
4. **Idempotency check (SB5 Option α).** If `current.status ===
'SUSPENDED'`, the function **returns the locked row** without
   updating, without emitting audit (§5.4).
5. **Transition validation.** `assertTransitionAllowed(parsedId,
current.status, 'SUSPENDED')` — throws `TenantStatusError` if the
   `ALLOWED_TRANSITIONS` map (per §1.3) does not permit the move.
   Permitted source: `ACTIVE` only. Disallowed sources: REQUESTED,
   PROVISIONING, READY, SUSPENDED (filtered by step 4 already),
   OFFBOARDING, TERMINATED.
6. **UPDATE the row.** `UPDATE tenant SET status = 'SUSPENDED',
updated_at = date_trunc('millisecond', now()) WHERE id = $1`.
   `updated_at` uses `msNow` (per §1's millisecond-truncation policy
   from migration 0006).
7. **Emit `TENANT_SUSPENDED`** (verb UPDATE; caller actor preserved
   per §9.3):
   ```typescript
   await emitAuditEvent(tx, {
     tenantId: parsedId,
     actorType: parsedActor.type,
     actorId: parsedActor.id,
     ...(parsedActor.description !== undefined && { actorDescription: parsedActor.description }),
     action: getActionByName(TENANT_AUDIT_ACTIONS, 'TENANT_SUSPENDED'),
     verb: 'UPDATE',
     resource: `tenant:${parsedId}`,
     before_state: { status: current.status },
     after_state: { status: 'SUSPENDED' },
     payload: { reason: parsedReason },
   });
   ```
   `payload.reason` flows through `@cortex/audit-events`'
   user-payload merge into `audit_event.payload.reason` (snake_case at
   wire layer). The `before_state` / `after_state` fields are auto-
   merged into `payload.before_state` / `payload.after_state` per the
   library's UPDATE-verb path.
8. **Transaction commits.** Function returns the new `SUSPENDED` row.

**Synchronous; no Cloud Tasks worker.** Suspension is a single state
transition with no multi-step orchestration (no Cloud SQL allocation,
no smoke test). No reason to enqueue an async task; the cascading
consequences (AC01 session revoke, etc.) run _outside_ F02's
transaction by subscribing to the audit event (§5.3).

### 5.2. Resume workflow (SUSPENDED → ACTIVE)

Sequence (per `tenants.ts:769` `resume`):

1. **Caller** invokes `tenants.resume(db, id, ctx)`. **No `reason`
   parameter** (Q-NEW-2 lock) — the audit chain shows what was
   suspended and why; resume's "why" is implicit ("ready again").
2. **Same single-transaction shape as suspend** — bind, lock, check
   idempotency (`current.status === 'ACTIVE'` returns no-op), validate
   transition, UPDATE, emit, commit.
3. **Emit `TENANT_STATUS_CHANGED`** (NOT `TENANT_RESUMED` — see
   asymmetry note below). `before_state.status` reflects the actual
   prior state (typically `'SUSPENDED'`); `after_state.status =
'ACTIVE'`.

**Why TENANT_STATUS_CHANGED, not a TENANT_RESUMED domain action?** Per
SB1 lock + planning-doc D6 hybrid catalog rule:

- `TENANT_SUSPENDED` exists because _suspending a tenant triggers
  cascade work_. AC01 needs a clean filter handle to revoke sessions;
  S15 needs a clean filter handle to halt device commands; S17 needs
  a clean filter handle to drain egress. Filtering on
  `action = 'TENANT_SUSPENDED'` is more durable than filtering on
  `action = 'TENANT_STATUS_CHANGED' AND
payload.after_state.status = 'SUSPENDED'`.
- Resume has no such cascade subscribers. Restoring ACTIVE state
  restores normal behavior; AC01 doesn't need a "session resume" hook
  (sessions don't auto-revive after revoke — users re-authenticate);
  S15/S17 resume on the next outbound action.
- One generic STATUS_CHANGED row reads cleanly in operator forensics;
  a new TENANT_RESUMED action would bloat the catalog without payoff.

### 5.3. Cascade-event handle (Q-OPEN-2 + planning-doc Drift 3/4)

`TENANT_SUSPENDED` is the _push-event handle_ downstream consumers
will subscribe to when they ship. F02 emits; consumers consume.
**F02 itself has zero subscribe-side code** — the cascade is one-way,
event-sourced, push-style (per planning-doc Drift 3 + Drift 4).

| Consumer                          | Trigger                 | Action on `TENANT_SUSPENDED`                                                                     |
| --------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| **AC01** (Agent Control 01, P2.1) | Subscribes when shipped | Revoke active sessions for the suspended tenant. Auth0 session-revoke RPC keyed on `tenant_id`.  |
| **S15** (Smart device pause)      | Subscribes when shipped | Halt outbound device commands; flush in-flight queue.                                            |
| **S17** (Outbound stop)           | Subscribes when shipped | Drain in-flight egress; pause new sends.                                                         |

**Subscription pattern (until Pub/Sub fan-out lands per roadmap
§4.12):** Pull-style. Consumers query `audit_event` directly, keyed on
a checkpoint cursor:

```sql
SELECT *
  FROM audit_event
 WHERE action = 'TENANT_SUSPENDED'
   AND occurred_at > $checkpoint
 ORDER BY occurred_at, ctid
 LIMIT $batch;
-- Consumer advances $checkpoint to MAX(occurred_at) of the batch.
```

The query targets only `TENANT_SUSPENDED` rows, NOT
`TENANT_STATUS_CHANGED` — the asymmetric design (§5.2) makes this
filter trivial. Consumers binding `app.tenant_id` per row is
necessary for RLS on `audit_event`; alternatively, a
cross-tenant-bypass role (deferred per ADR-DB-002 §"Decision" #4) can
read all tenants' rows in one pass.

**Pub/Sub fan-out future** (roadmap §4.12, RESOLVED 2026-04-27 in the
sense that the cycle decoupling is done; the Pub/Sub _integration_ is
still future): each emitted audit event additionally publishes to a
Cloud Pub/Sub topic; consumers subscribe to the topic instead of
polling `audit_event`. F02's emit-side already works for both
patterns — the only change is adding the publish step to
`@cortex/audit-events`.

### 5.4. Idempotency semantics (SB5 Option α)

| Scenario                                       | Result                            | Audit emission                  |
| ---------------------------------------------- | --------------------------------- | ------------------------------- |
| `suspend` on an `ACTIVE` tenant                | UPDATE → SUSPENDED                | 1 × `TENANT_SUSPENDED` row      |
| `suspend` on an already-`SUSPENDED` tenant     | Returns the current row unchanged | **None**                        |
| `resume` on a `SUSPENDED` tenant               | UPDATE → ACTIVE                   | 1 × `TENANT_STATUS_CHANGED` row |
| `resume` on an already-`ACTIVE` tenant         | Returns the current row unchanged | **None**                        |
| `suspend` on a `REQUESTED`/`TERMINATED` tenant | Throws `TenantStatusError`        | None                            |

**Rationale.** Operators retrying after a flaky network response
should see clean success rather than `TenantStatusError`. Logging a
no-op audit row would be misleading: no state change occurred, so
the row would falsely suggest one did. The original suspend's audit
row remains the canonical record of when/why the tenant was
suspended; subsequent retry calls add no information.

**Distinction from `setStatus`.** The `tenants.setStatus` JSDoc
rationale (_"silent success when nothing changed would lie to the
audit log"_) applies to direct `setStatus` callers. `suspend` and
`resume` are higher-level workflow functions; they carry their own
idempotency contract above `setStatus` because operator-facing
surfaces benefit from the friendlier semantics.

### 5.5. Concurrency semantics (SB2 + §10.15)

**Pessimistic row lock** via `SELECT ... FOR UPDATE` (line 692 in
`tenants.ts`). Postgres's lock manager serializes concurrent
state-change attempts on the same tenant row at the database layer —
no application-side coordination required.

**Two-suspend race scenario** (the worry §10.15 surfaces):

1. Operator A and Operator B both invoke `tenants.suspend(db,
tenantId, ..., {actor})` simultaneously.
2. Both calls open their own transactions on independent pool clients
   (Drizzle's `db.transaction` acquires distinct `PoolClient`
   instances per call).
3. **A wins the lock first** (Postgres FIFO on the lock manager). A's
   transaction holds the row exclusively.
4. **B's `SELECT ... FOR UPDATE` blocks** — Postgres parks B's
   request on the lock manager's wait queue.
5. **A executes UPDATE → audit emit → COMMIT.** Lock released.
6. **B unblocks.** B's SELECT returns the _post-A_ state: `SUSPENDED`.
7. **B's idempotency check (SB5 Option α) fires.** `current.status ===
'SUSPENDED'` → B returns the row without UPDATE, without audit emit.

**Net effect:** Exactly one `TENANT_SUSPENDED` audit row. Both calls
return the SUSPENDED row. Operator B has no signal that A's call
"won" — both responses look like clean success, which is the
operator-facing contract we want.

**§10.15 verification (sub-phase 3 ships 3 tests):**

| Test                               | What it proves                                                             | Mechanism                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lock proof under barrier           | tx2's SELECT FOR UPDATE blocks until tx1 commits; tx2 reads post-tx1 state | `withTwoBoundClients` helper + `Deferred<void>` barrier; tx1 holds lock; tx2 awaits barrier then attempts contended SELECT                                              |
| Production-path concurrent suspend | `Promise.all([suspend, suspend])` produces exactly 1 audit row             | Two real `tenants.suspend()` calls; lock + SB5 Option α together yield single audit emission                                                                            |
| Drizzle SQL regression guard       | `tenants.suspend` actually emits `SELECT … FOR UPDATE` SQL                 | Custom Drizzle Logger (`logQuery`) captures every SQL statement issued during a real suspend; matcher requires `SELECT` + `FROM tenant` + `FOR UPDATE` on the same line |

The third test is the regression guard §10.15 explicitly worries
about: a future refactor that silently drops `.for('update')` from
the query construction would leave the lock unverified. The Drizzle
logger captures the _actual_ SQL run by `tenants.suspend`, so a
regression in production code path fails the test directly — not in
some equivalently-constructed test query that happens to lock.

**Generalized helper.** `withTwoBoundClients(pool, tenantId, fn1,
fn2)` (per Q-NEW-5) lives in `packages/tenant-context/test/helpers/db.ts`.
Acquires two pooled `PoolClient`s, wraps each with Drizzle, opens
two parallel transactions both auto-bound to the same tenant. Returns
`Promise.all([fn1Result, fn2Result])`. Use this for any future
two-connection contention test (Slice C and Slice D will likely need
it for offboarding-during-key-rotation and similar scenarios).

### 5.6. Status guards

Per `ALLOWED_TRANSITIONS` map in `tenants.ts:157` (per ADR-LIFECYCLE-001

- §1.3):

| Function          | Allowed source(s) | Disallowed source(s)                                                                                                      |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tenants.suspend` | `ACTIVE`          | `REQUESTED`, `PROVISIONING`, `READY`, `SUSPENDED` (handled by §5.4 idempotency, not a throw), `OFFBOARDING`, `TERMINATED` |
| `tenants.resume`  | `SUSPENDED`       | `REQUESTED`, `PROVISIONING`, `READY` (see note), `ACTIVE` (handled by §5.4 idempotency), `OFFBOARDING`, `TERMINATED`      |

**Note on `READY → ACTIVE`.** The `ALLOWED_TRANSITIONS` map permits
`READY → ACTIVE` because that's the _provisioning worker's_ path
(per §1.3). `tenants.resume` does not gate on "must be SUSPENDED"
beyond what `assertTransitionAllowed` checks; in principle, calling
`resume` from `READY` would succeed because the transition is
permitted. In practice, operators don't observe `READY` (the worker
advances through it within milliseconds), so this is a documentation
contract rather than a code-enforced constraint. Slice D may add a
strict "resume is SUSPENDED-only" guard at the HTTP API surface
without changing the function signature.

Disallowed transitions raise `TenantStatusError` with the current
status and the set of allowed targets — caller layer can map to a
409 Conflict at the HTTP boundary (per §1's status-mapping table).

### 5.7. Forensic queries (operator runbook)

| Query                                                                                                                                                                                                                                                                                                                                                                | Purpose                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `SELECT * FROM audit_event WHERE tenant_id = $1 AND action IN ('TENANT_SUSPENDED', 'TENANT_STATUS_CHANGED') ORDER BY occurred_at`                                                                                                                                                                                                                                    | Full suspend/resume history for tenant X.                                                                                      |
| `SELECT payload->>'reason' AS reason, occurred_at, actor_id FROM audit_event WHERE tenant_id = $1 AND action = 'TENANT_SUSPENDED' ORDER BY occurred_at DESC LIMIT 1`                                                                                                                                                                                                 | Most recent suspension reason + timestamp + operator.                                                                          |
| `SELECT now() - occurred_at AS suspended_for FROM audit_event WHERE tenant_id = $1 AND action = 'TENANT_SUSPENDED' ORDER BY occurred_at DESC LIMIT 1`                                                                                                                                                                                                                | Suspension duration (for tenants currently SUSPENDED — caller verifies `tenant.status='SUSPENDED'`).                           |
| `SELECT tenant_id, COUNT(*) AS suspend_count FROM audit_event WHERE action = 'TENANT_SUSPENDED' GROUP BY tenant_id HAVING COUNT(*) > 3 ORDER BY suspend_count DESC`                                                                                                                                                                                                  | Tenants with frequent suspensions (>3) — operator review signal.                                                               |
| `SELECT tenant_id FROM audit_event WHERE action = 'TENANT_SUSPENDED' AND tenant_id NOT IN (SELECT tenant_id FROM audit_event WHERE action = 'TENANT_STATUS_CHANGED' AND payload->'after_state'->>'status' = 'ACTIVE' AND occurred_at > (SELECT MAX(occurred_at) FROM audit_event a2 WHERE a2.tenant_id = audit_event.tenant_id AND a2.action = 'TENANT_SUSPENDED'))` | Tenants currently suspended (last suspend has no subsequent resume). Cross-reference with `tenant.status` for canonical truth. |

**Audit chain integrity.** A `suspend → resume → suspend` cycle
produces three rows in occurrence order: `TENANT_SUSPENDED` (×1) →
`TENANT_STATUS_CHANGED` (×1, with `before_state.status='SUSPENDED'`,
`after_state.status='ACTIVE'`) → `TENANT_SUSPENDED` (×1). The
append-only chain (per ADR-DB-003) preserves the full operator
history; no row is overwritten or deleted. SB5 Option α idempotency
guarantees that retried no-op calls do NOT pollute this history.

**Reason field semantics.** `payload.reason` is operator-supplied
free-form text (1–500 chars). Convention: human-readable rationale
("manual ops review per ticket SEC-1234", "auto-suspend by
billing-overdue worker", "compliance hold pending legal review").
Future consumers (AC01/S15/S17) can parse reason for structured
codes if needed; today no parser depends on a specific shape.

## 6. Offboarding + termination + legal hold `[F02-C]`

F02 Slice C ships the destructive end of the lifecycle: voluntary
offboarding (with grace-period scheduling + export archive),
operator-driven termination (with the 5-step cascade + soft-retain
tombstone), the legal-hold helper API (per-tenant fast path + granular
table), and the Super Admin override (`forceTerminate`) for
hold-or-grace bypass with full forensic capture. §6.5–6.7 cover the
cross-cutting idempotency, failure-recovery, and forensic-query
patterns shared across these workflows.

### 6.1. Offboarding

- `tenants.offboard(db, tenantId, ctx)` flips `status` ACTIVE/SUSPENDED
  → OFFBOARDING. Sets `tenant.offboarding_grace_until` to
  `now() + grace_period` (default 30 days; configurable per Q-OPEN-3
  - spec §3).
- Generates a per-tenant export archive at
  `gs://{tenant_data_bucket}/tenants/{tenantId}/exports/{timestamp}.jsonl.gz`
  per Q-NEW-C4 lock: gzipped JSON Lines with a schema-versioned
  envelope per record (`{schema_version: '1', entity_type, entity_id,
data}`). Six entity types: `tenant`, `tenant_config_version`,
  `tenant_kms_key` (resource_name only — no key material; KMS owns
  keys), `audit_event` (full chain), `tenant_quota_usage`, `legal_hold`.
  The schema-versioned envelope enables additive schema migration
  without breaking older archives (e.g., switching a specific
  `entity_type` to Parquet later remains backward-compatible).
- **Two distinct retention concepts** (Q-NEW-C6 lock):
  - **Pre-signed URL TTL: 7 days** (GCS V4 server-side cap). The
    signed URL is delivered to the operator/auditor via the
    `tenants.offboard` return value; the URL expires after 7 days
    regardless of object retention.
  - **Object retention: 30 days target** (per spec §3). Implemented
    as a future GCS lifecycle policy on the tenant-data bucket — not
    in any current sub-phase's TF; deferred until first production
    tenant offboards.
  - **Operator URL refresh:** when the original signed URL expires
    before delivery, a future `tenants.regenerateOffboardingArchiveUrl(tenantId)`
    helper will fetch the most recent `gcsUri` from the tenant's
    `TENANT_OFFBOARDING_STARTED` audit row and re-sign for another
    7 days. Function signature documented for forward reference;
    implementation lands when the first production offboarding
    requires it.
- **Signing identity (staged rollout, sub-phase 7.6):**
  - **TF (✓ landed):** Per-env `cortex-export-signer-{env}` SA exists
    via the `cortex-signer-sa` module. Runtime SA
    (`tenant-lifecycle-runtime`, project-scoped) holds
    `roles/iam.serviceAccountTokenCreator` on the signer SA. Signer
    SA holds `roles/storage.objectViewer` on the env's tenant-data
    bucket (so signed URLs grant valid GCS read access once
    impersonation lands).
  - **Application impersonation (deferred):** `export-archive.ts`
    currently signs URLs as the runtime SA via default ADC (the
    runtime SA itself has the bucket read access needed for signed
    URLs to work). A future polish task switches to
    `GoogleAuth({ targetPrincipal: <signerSAEmail> })` calling IAM
    SignBlob, decoupling signing authority from runtime authority
    for defense-in-depth + audit clarity. The TF landed in 7.6
    supports this swap with no infrastructure rollout — runtime SA
    already has TokenCreator, signer SA already has bucket access.
  - **Phase 1 reality:** 0 production tenants today, so no real
    signed URL is gated by the staging gap. Per convention §10.8
    lock — per-env signer, NOT per-tenant.
- Emits `TENANT_OFFBOARDING_STARTED` audit event (UPDATE; caller
  actor). `after_state` captures `status='OFFBOARDING'` +
  `offboarding_grace_until`. `payload` captures `gracePeriodDays` +
  `exportArchive: { gcsUri, fullObjectPath, bucket, sizeBytes,
schemaVersion, entityCounts, generatedAt }`. **`signedUrl` is
  deliberately excluded** from the audit row — the signed URL is a
  short-lived auth token; logging it leaks credentials. Operators
  recover `gcsUri` from the audit payload and re-sign via the future
  `regenerateOffboardingArchiveUrl` helper if needed.
- Schedules a Cloud Task on `lifecycle-queue` with
  `taskId='terminate-{tenantId}'` and `scheduleTime=grace_until`
  for the eventual termination.

### 6.2. Termination

- `tenants.terminate(db, tenantId, ctx, options?)` advances OFFBOARDING
  → TERMINATED. **Soft-retain tombstone** + hard-delete children per
  Q-NEW-C8 (lock 2026-04-28): ADR-COMPUTE-001 supersedes spec deviation 1
  (Cloud Run services, not K8s namespaces). 5-step cascade:
  1. Tenant Cloud Run service(s) — delete per-tenant
     `{workload}-tenant-{uuid}` services (ENTERPRISE only). Phase 1
     **STUB** per Q-NEW-C5: TODO marker only; lights up with
     ADR-INFRA-005 swap (Slice D's per-tenant Cloud Run TF module).
     Standard tenants share infra; this step is N/A for them.
  2. Tenant GCS prefix — delete `tenants/{tenantId}/...` recursively
     in the env's tenant-data bucket via
     `bucket.deleteFiles({prefix, force: true})`. `force: true` makes
     the call idempotent (no error if prefix is empty — supports
     retry-from-scratch per SC4 lock).
  3. Tenant Cloud SQL instance (ENTERPRISE only) — delete dedicated
     instance. Phase 1 **STUB** per Q-NEW-C5: TODO marker; lights up
     with ADR-INFRA-005 swap.
  4. **Shared-DB cascade (single transaction).** Three ordered
     actions: (a) emit `TENANT_TERMINATED` audit event BEFORE the
     deletes — RLS write policy requires `app.tenant_id` bound to
     an extant tenant row; the soft-retain UPDATE comes after so
     the audit's `before_state` snapshot captures `tier`,
     `external_id`, `display_name`, `kms_key_resource_name`, and
     the `offboarding_grace_until` timestamp. (b) Hard-delete
     children: `legal_hold` (active + released — full wipe per
     spec §3 "deletes every tenant-scoped trace"; the audit chain
     is the historical record), `tenant_kms_key`,
     `tenant_config_version`, `tenant_quota_usage`. Order is
     arbitrary — none of these tables FK each other; all FK to
     `tenant` (which we soft-retain). (c) Soft-retain the `tenant`
     row via `UPDATE tenant SET status='TERMINATED', terminated_at=msNow, updated_at=msNow`.
     The tombstone keeps `audit_event.tenant_id` references valid
     for forensic queries. `tenants.get` / `tenants.getByExternalId`
     filter `status='TERMINATED'` at the application layer and
     surface `TenantNotFoundError` — indistinguishable from hard
     delete at the API surface, satisfying spec §3's
     "post-termination queries return tenant-not-found".
     `tenants.list` is intentionally unfiltered so operators can
     review tombstones for compliance.
  5. KMS key tombstone — Phase 1 records `kms_key_resource_name` in
     the `TENANT_TERMINATED` audit payload as the tombstone signal
     (Q-NEW-C11). NO destroy call: env-level `cortex-general-key` is
     shared across tenants; destroying it would break every tenant.
     Future per-tenant CMEK swap (ADR-INFRA-007) lights up
     `keys.scheduleDestroy(versionPath, scheduledDestroyDuration='7d')`
     (7-day recovery window for incident-response headroom; beats GCP's
     24h default).

- **Audit emission:** `TENANT_TERMINATED` (DELETE verb; caller actor).
  Records `before_state` (full pre-termination snapshot +
  `kms_key_resource_name`) and `payload.cascade_steps` (per-step status
  markers — `EXECUTED` / `STUB_TODO_ADR_INFRA_005` / `NA_STANDARD` /
  `TOMBSTONE_ONLY_PHASE_1`). DELETE-verb audit rows have no
  `after_state` per the discriminated-union contract; the soft-retain
  UPDATE following the emit is captured implicitly by the row's new
  status.
- **Idempotency** (SA11 pattern): re-call on a TERMINATED tombstone
  returns the row without re-emitting audit, re-running the GCS delete,
  or re-applying the soft-retain UPDATE. Phase 1 fast-path read +
  Phase 4 row-locked re-check guarantee race safety even under
  concurrent operators.
- **Failure semantics** (SC4 lock — retry-from-scratch with per-step
  pre-checks): each cascade step is independently idempotent. If
  Phase 4's txn fails after a successful Phase 3 GCS delete, the
  tenant remains in OFFBOARDING; operator re-runs `tenants.terminate`,
  which sees an already-empty GCS prefix (no-op) and converges to the
  same final state. No "partial cascade" recovery state machine.
- **Legal-hold guard** runs in Phase 2 BEFORE any destructive step
  (per §6.3 dual-source). Active hold → `TenantLegalHoldError`; use
  `tenants.forceTerminate` for Super Admin override (Slice C
  sub-phase 7.5).
- **Grace-period guard** runs in Phase 2: `now() >= offboarding_grace_until`
  required (Q-NEW-C10 strict; trust Cloud Tasks retry on near-boundary
  early-fires). Else `TenantGraceNotElapsedError`.
- **Post-termination semantics:** `tenants.get` / `getByExternalId`
  surface `TenantNotFoundError`; `tenants.list` shows the tombstone
  (status='TERMINATED', terminated_at populated). Audit chain remains
  queryable indefinitely (append-only ADR-DB-003 — `audit_event` has no
  FK to `tenant`, so the chain survives independent of the tombstone).

### 6.3. Legal hold (Q-OPEN-3)

Two-tier hold model — per-tenant fast path AND granular table — both
checked by `tenants.terminate`.

**Fast path** (`tenant.legal_hold` boolean, migration 0010): O(1)
lookup flag per tenant. Set via direct DB UPDATE today (no audit
emit; the `legalHolds.set` helper covers richer scenarios).
`tenants.terminate` short-circuits on this when `true`.

**Granular path** (`legal_hold` table, migration 0011): three-scope
discriminator (`tenant` | `record` | `data_class`):

```sql
legal_hold (id, tenant_id, scope, record_id?, data_class?,
            reason, set_by_user_id, set_at,
            released_at?, released_by_user_id?)
```

Termination workflow queries:

```sql
tenant.legal_hold = true
OR EXISTS (SELECT 1 FROM legal_hold WHERE tenant_id = $1 AND released_at IS NULL)
```

Both checked at every terminate call; either active hold blocks.

**Helper API** (Slice C sub-phase 7.5):

- `legalHolds.set(db, tenantId, options, ctx)` — places a hold per
  the scope discriminator. Emits `LEGAL_HOLD_SET` audit event with
  `after_state` capturing the hold's shape (scope, reason,
  set_by_user_id, plus record_id or data_class when applicable).
  - **NOT idempotent** — every call inserts a new row. Multiple
    active holds for the same scope/target are valid; release each
    independently.
  - Refuses on TERMINATED tenants (no holds on tombstones).
  - Phase 1 enforcement: only `scope='tenant'` blocks termination.
    `scope='record'` and `scope='data_class'` are stored but not yet
    consumed; Phase 2+ application code (e.g., `records.delete`)
    will enforce when those modules ship.
- `legalHolds.release(db, tenantId, holdId, options, ctx)` — releases
  an existing hold. Sets `released_at` + `released_by_user_id`; row
  is preserved as a historical record. Emits `LEGAL_HOLD_RELEASED`
  (DELETE verb — the assertion is "deleted" even though the row
  persists).
  - **Idempotent** — re-call on already-released hold returns row
    without re-emitting audit.
  - Caller MUST supply `tenantId` even though `holdId` is unique:
    RLS on `legal_hold` requires `app.tenant_id` bound BEFORE any
    read, and the hold's tenant_id can't be discovered without that
    bind (chicken-and-egg).

**RLS contract:** both helpers bind `app.tenant_id` to `tenantId`
before any read/write. Cross-tenant access fails closed (release of
a foreign-tenant's hold throws `TenantNotFoundError`).

**Super Admin override.** Per spec §3, legal-hold-blocked
termination CAN proceed via a Super Admin override.
`tenants.forceTerminate` ships the override (see §6.4). Both the
boolean fast path AND active table holds are bypassed; bypassed
details are captured in the audit payload's `override_metadata` for
forensic attribution. Until AC01 ships, the Super Admin role is the
bootstrap admin (P0.9).

### 6.4. Force termination (Super Admin override) `[F02-C]`

`tenants.forceTerminate(db, id, reason, ctx, options?)` is the
override path for `tenants.terminate`. Per F02 Slice C SC2 lock, it
emits a dedicated `TENANT_FORCE_TERMINATED` audit action (NOT
`TENANT_TERMINATED`) so compliance regulators can grep for "tenant
terminated despite an active hold or before grace elapsed" without
parsing payload metadata.

**Differences from `tenants.terminate`:**

- **Skips legal-hold check.** Active hold details are still captured
  in `payload.override_metadata.active_legal_hold` (scope + reason +
  set_by_user_id) for forensic attribution — operators reviewing the
  override can see exactly what was bypassed.
- **Skips grace-period check.** OFFBOARDING tenants can be
  force-terminated mid-grace; ACTIVE / SUSPENDED tenants skip
  OFFBOARDING entirely. Whether the grace was actually skipped is
  recorded in `payload.override_metadata.skipped_grace_period`.
- **Requires `reason`** — operator's narrative justification,
  validated 1-2000 chars and captured in `payload.reason`. Empty
  reason → `TenantValidationError`.
- **Allowed transitions:** ACTIVE / SUSPENDED / OFFBOARDING →
  TERMINATED. Pre-public states (REQUESTED, PROVISIONING, READY)
  reject with `TenantStatusError` — those tenants haven't gone
  public; use `cleanupFailedProvisioning` instead.

**Cascade + audit shape:** identical to `tenants.terminate` (5-step
external + shared-DB + KMS tombstone) except for the audit action
and the additional `override_metadata` payload field:

```ts
override_metadata: {
  skipped_legal_hold: boolean,        // true if any active hold existed
  skipped_grace_period: boolean,      // true if status=OFFBOARDING and grace not elapsed
  active_legal_hold?: { scope, reason, set_by_user_id },  // present iff a granular hold was bypassed
  tenant_legal_hold_boolean_was_set?: true,  // present iff fast-path boolean was true
}
```

**Idempotency** mirrors `terminate`: re-call on a TERMINATED
tombstone returns the row, no audit re-emit, no GCS re-delete.

**Authz:** Phase 1 has no enforcement at this layer — anything that
imports the package can call. AC01 will gate via per-method authz
(recorded as a deviation in F02 deviations + future-roadmap §10.12).

**Forensic-query examples:**

```sql
-- Every force-termination across the platform:
SELECT * FROM audit_event
WHERE action = 'TENANT_FORCE_TERMINATED'
ORDER BY occurred_at DESC;

-- Force-terminations that bypassed an active legal hold:
SELECT * FROM audit_event
WHERE action = 'TENANT_FORCE_TERMINATED'
  AND payload->'override_metadata'->>'skipped_legal_hold' = 'true'
ORDER BY occurred_at DESC;

-- Force-terminations that bypassed grace periods:
SELECT * FROM audit_event
WHERE action = 'TENANT_FORCE_TERMINATED'
  AND payload->'override_metadata'->>'skipped_grace_period' = 'true'
ORDER BY occurred_at DESC;
```

### 6.5. Idempotency semantics

All §6 lifecycle workflows are designed to be safely re-callable
without producing duplicate state mutations or audit rows. The
pattern follows the SB5 Option α precedent from §5 (suspend/resume):
an unlocked Phase 1 fast-path read for the common-case retry, plus
a row-locked Phase 3/4 re-check for race safety under concurrent
operators.

**Per-workflow idempotency:**

| Workflow                 | Fast-path on              | Behavior on retry                                                                                                                                                                                         |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants.offboard`       | `status='OFFBOARDING'`    | Returns existing row + `graceUntil` + `exportArchive: undefined`; no audit re-emit; no archive regeneration; no Cloud Task re-dispatch.                                                                   |
| `tenants.terminate`      | `status='TERMINATED'`     | Returns tombstone row; no audit re-emit; no GCS re-delete; no children re-delete (already gone).                                                                                                          |
| `tenants.forceTerminate` | `status='TERMINATED'`     | Same as `terminate`. The override path's idempotency mirrors the regular path.                                                                                                                            |
| `legalHolds.set`         | **NEVER idempotent**      | Each call inserts a new `legal_hold` row. Multiple active holds for the same scope+target are valid (different reasons, different setters). Operators wanting "set if not already held" must check first. |
| `legalHolds.release`     | `released_at IS NOT NULL` | Returns the released row unchanged; no audit re-emit.                                                                                                                                                     |

**Race-safe re-check pattern.** The Phase 1 fast-path read is
unlocked (no `SELECT FOR UPDATE`) — optimistic for the common-case
retry. If the row's status indicates the workflow already completed,
return early. Otherwise, the workflow proceeds to a Phase 3 or 4
transaction (depending on workflow shape) that begins with a
row-locked re-read. Between Phase 1's read and Phase 3/4's lock, a
parallel operator may have completed the workflow; the locked
re-check catches this and returns the now-completed row without
re-running destructive steps.

The race-window cost is a possible wasted archive in GCS (offboard)
or wasted external-cascade calls (terminate / forceTerminate), but
no double-state-mutation: the locked re-check guarantees only one
operator's transaction commits the state transition.

**Why not idempotency keys?** The workflows above use natural
state-based idempotency — the row's `status` IS the idempotency
token. An explicit `idempotency_key` column would add complexity
without benefit: the state-machine semantics already provide the
"don't re-do completed work" guarantee, and the locked re-check
provides race safety. If a future use case requires operator-supplied
keys (e.g., "this is request id X; don't re-process"), it would be
additive: a new column + check before Phase 1's fast-path. Phase 1
has no such use case.

### 6.6. Failure recovery semantics

Per F02 Slice C SC4 lock: lifecycle workflows use **retry-from-scratch
with per-step pre-checks**. There is no "resume from where I failed"
state machine — each retry begins at Phase 1 and reaches the same
final state via the §6.5 idempotency mechanisms.

**Per-cascade-step failure modes** (`tenants.terminate` +
`tenants.forceTerminate`):

| Step                              | Failure mode                                               | Recovery                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cloud Run delete (ENTERPRISE)  | Phase 1 STUB; no failure modes today (TODO log only).      | Future ADR-INFRA-005 swap: retry sees the service-already-deleted case as a no-op.                                                                                                                      |
| 2. GCS prefix delete              | Network / IAM / quota errors at `bucket.deleteFiles(...)`. | `force: true` makes empty-prefix retry a no-op. Operator retries the whole `terminate` call.                                                                                                            |
| 3. Cloud SQL delete (ENTERPRISE)  | Phase 1 STUB; no failure modes today.                      | Future ADR-INFRA-005 swap: same retry semantic as Cloud Run.                                                                                                                                            |
| 4. Shared-DB cascade (single txn) | DB connection / RLS / audit-emit / FK constraint failures. | Whole txn rolls back; tenant remains in pre-call state. §6.5 idempotency guarantees safe retry.                                                                                                         |
| 5. KMS tombstone                  | Phase 1: no destroy call (env-level shared key).           | Audit row captures `kms_key_resource_name` as the tombstone signal. Future ADR-INFRA-007 swap: `keys.scheduleDestroy` with a 7-day recovery window allows operator-led undo within the recovery period. |

**Offboard failure modes** (`tenants.offboard`):

| Phase                            | Failure mode                                             | Recovery                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Preflight                     | `TenantNotFoundError` / `TenantStatusError` / RLS error. | Operator-visible error; no state mutation.                                                                                                                                                                                                                                                                                                    |
| 2. Archive generation            | GCS upload error / IAM error.                            | No state mutation; tenant remains in pre-OFFBOARDING status. Operator retries.                                                                                                                                                                                                                                                                |
| 3. State transition (single txn) | DB error / audit-emit error.                             | Whole txn rolls back; archive in GCS is orphaned (no security implication; same tenant prefix). Operator retries; new archive generated.                                                                                                                                                                                                      |
| 4. Cloud Tasks dispatch          | Network / IAM error at `dispatchCloudTask`.              | **Tenant is OFFBOARDING + audit emitted, but no scheduled terminate task.** Operator must reconcile: re-call `tenants.offboard` (idempotent fast-path returns existing state) and explicitly re-dispatch via Cloud Tasks SDK, OR call `tenants.terminate` directly after `grace_until` elapses. The only failure mode requiring intervention. |

**What does NOT happen:**

- No per-step "I got 3 of 5 done" progress column on the tenant row.
- No `terminate_progress` JSONB tracking which steps completed.
- No background reconciliation worker watching for stuck terminations.
- No "partial cascade" recovery state machine.

The convention's stance: per-step idempotency + per-call atomicity
(single txn for the shared-DB cascade; `force: true` on GCS deletes;
stub markers for Cloud Run / Cloud SQL) makes whole-cascade retry
safe and operationally simple. Operators retry the top-level call;
the system converges to the correct final state regardless of which
step previously failed.

### 6.7. Forensic queries

Operator runbook for compliance and incident-response queries against
the audit substrate. All queries assume an RLS-bound session for
those touching `tenant_kms_key` / `legal_hold`; queries against
`tenant` and `audit_event` are RLS-bound to a specific tenant or run
as a privileged audit role.

**a. All offboardings within a date range:**

```sql
SELECT
  ae.tenant_id,
  ae.occurred_at,
  ae.actor_id,
  ae.payload->'exportArchive'->>'gcsUri' AS archive_gcs_uri,
  ae.payload->>'gracePeriodDays' AS grace_period_days
FROM audit_event ae
WHERE ae.action = 'TENANT_OFFBOARDING_STARTED'
  AND ae.occurred_at BETWEEN $1 AND $2
ORDER BY ae.occurred_at;
```

**b. All terminations (regular + force) within a date range:**

```sql
SELECT
  ae.tenant_id,
  ae.occurred_at,
  ae.actor_id,
  ae.action,                                           -- TENANT_TERMINATED or TENANT_FORCE_TERMINATED
  ae.payload->>'reason' AS force_reason,               -- only set for TENANT_FORCE_TERMINATED
  ae.payload->'override_metadata' AS override_metadata
FROM audit_event ae
WHERE ae.action IN ('TENANT_TERMINATED', 'TENANT_FORCE_TERMINATED')
  AND ae.occurred_at BETWEEN $1 AND $2
ORDER BY ae.occurred_at;
```

**c. Force-terminations that bypassed an active legal hold** (compliance category 1):

```sql
SELECT
  ae.tenant_id,
  ae.occurred_at,
  ae.actor_id,
  ae.payload->>'reason' AS force_reason,
  ae.payload->'override_metadata'->'active_legal_hold' AS bypassed_hold
FROM audit_event ae
WHERE ae.action = 'TENANT_FORCE_TERMINATED'
  AND (ae.payload->'override_metadata'->>'skipped_legal_hold')::boolean = true
ORDER BY ae.occurred_at DESC;
```

**d. Force-terminations that bypassed grace period:**

```sql
SELECT
  ae.tenant_id,
  ae.occurred_at,
  ae.actor_id,
  ae.payload->>'reason' AS force_reason
FROM audit_event ae
WHERE ae.action = 'TENANT_FORCE_TERMINATED'
  AND (ae.payload->'override_metadata'->>'skipped_grace_period')::boolean = true
ORDER BY ae.occurred_at DESC;
```

**e. All active legal holds across the platform** (privileged audit role required for cross-tenant scan):

```sql
SELECT
  lh.tenant_id,
  lh.scope,
  lh.record_id,
  lh.data_class,
  lh.reason,
  lh.set_by_user_id,
  lh.set_at
FROM legal_hold lh
WHERE lh.released_at IS NULL
ORDER BY lh.tenant_id, lh.set_at;
```

**f. Full lifecycle chain for a specific terminated tenant** (audit reconstruction post-termination):

```sql
SELECT
  ae.action,
  ae.verb,
  ae.actor_id,
  ae.actor_type,
  ae.occurred_at,
  ae.before_state,
  ae.after_state,
  ae.payload
FROM audit_event ae
WHERE ae.tenant_id = $1
ORDER BY ae.occurred_at, ae.event_id;
-- The tombstone tenant row remains queryable via direct SQL:
--   SELECT * FROM tenant WHERE id = $1;
-- → returns row with status='TERMINATED', terminated_at populated.
-- `tenants.get` throws TenantNotFoundError per Q-NEW-C8 application-layer filter.
```

**g. GCS path of a tenant's last export archive** (operator retrieval):

```sql
SELECT
  ae.tenant_id,
  ae.occurred_at AS exported_at,
  ae.payload->'exportArchive'->>'gcsUri' AS archive_gcs_uri,
  ae.payload->'exportArchive'->>'sizeBytes' AS size_bytes,
  ae.payload->'exportArchive'->>'schemaVersion' AS schema_version
FROM audit_event ae
WHERE ae.tenant_id = $1
  AND ae.action = 'TENANT_OFFBOARDING_STARTED'
ORDER BY ae.occurred_at DESC
LIMIT 1;
```

**h. Released legal holds with reasons + release attribution:**

```sql
SELECT
  lh.tenant_id,
  lh.scope,
  lh.reason AS hold_reason,
  lh.set_by_user_id,
  lh.set_at,
  lh.released_at,
  lh.released_by_user_id
FROM legal_hold lh
WHERE lh.tenant_id = $1
  AND lh.released_at IS NOT NULL
ORDER BY lh.released_at DESC;
```

These queries form the backbone of compliance / incident-response /
audit-trail review. The audit chain's append-only invariant
(ADR-DB-003) guarantees historically accurate results regardless of
when the queries run — including against terminated tenants whose
substrate has been destroyed.

## 7. Key rotation + dual-key overlap `[F02-D]`

**Slice D placeholder.** Workflow shape — pinned context:

- `tenants.rotateKeys(db, tenantId, ctx)` updates
  `tenant_kms_key.kms_key_resource_name` to a new KMS key. Sets
  `tenant.last_key_rotated_at = now()`.
- Emits `TENANT_KEY_ROTATED` audit event (UPDATE; caller actor;
  records both `before_state.kms_key_resource_name` and
  `after_state.kms_key_resource_name` for the forensic chain).
- 90-day cadence: scheduled task on `key-rotation-queue` (per
  planning-doc Q-OPEN-1) fires when `now() - tenant.last_key_rotated_at > 90 days`.
- On-demand: HTTP API endpoint (Slice D) lets operators trigger
  rotation manually.
- **Dual-key overlap window.** Per spec §5: in-flight encrypts and
  decrypts continue to succeed during the rotation cutover. F02's
  §4.15 cleanup vector resolution (sub-phase 6.1) made this
  mechanically correct: `EncryptedPayload.keyResourceName` is
  recorded at encrypt time and threaded through to `envelope.decrypt`
  at decrypt time. After rotation, the new key is recorded in
  `tenant_kms_key`; new encrypts use it; old payloads decrypt
  successfully via their recorded (old) key resource name. Both
  keys must remain valid in KMS for the overlap window — the old
  key's destruction is delayed (typically 30 days) so any in-flight
  decrypt has time to complete.
- HTTP API endpoint (operator-facing): `POST /v1/tenants/{id}/rotate-keys`.
  Cloud Run service-to-service IAM (per planning-doc D8); AC01
  layers per-method authz when shipped.

### 7.1. Prototype existence + skeleton `[F02-D.1]`

Slice D D.1 ships the operator-facing HTTP service skeleton at
`apps/tenant-lifecycle-api/`. Cloud Run service name
`tenant-lifecycle-shared` per ADR-COMPUTE-001 §3 (STANDARD shared
shape; ENTERPRISE per-tenant `tenant-lifecycle-tenant-{uuid}` lights
up at F02 swap). Hono v4 + companion deps locked at D.1 per
ADR-HTTP-001 Conditions 1, 4, 5; framework choice resolved by
ADR-HTTP-001.

**D.1 route surface (minimum to verify Conditions 2 + 3):**

| Method + Path          | Purpose                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health`          | Liveness probe; no DB; `skipPaths` bypasses tenant binding.                                    |
| `GET /v1/tenants/{id}` | Read; uses `withTenantDbClient` per Q-NEW-D-8 + `tenants.get` from `@cortex/tenant-context`.   |
| `GET /v1/test/slow-5s` | **Dev-only** (gated by `ENABLE_TEST_ROUTES=true` env). 5 s sleep for SD4 SIGTERM verification. |

The remaining 11 endpoints from planning-doc SD7 land at D.3.

**SIGTERM handler shape (per ADR-HTTP-001 Condition 3 + SD4):**

`@hono/node-server`'s `serve()` returns a Node `http.Server`. Entry
point (`src/index.ts`) registers `process.on('SIGTERM', ...)` and
`process.on('SIGINT', ...)` handlers calling `server.close(...)` to
drain in-flight requests, then `telemetry.shutdown()` to flush OTLP,
then `pool.end()` to release pg connections. Hard-cap fallback at 8 s
per SD4 (Cloud Run grants 10 s; we exit by 8 s to leave 2 s margin —
the SOFT FAIL row of the D.1 SIGTERM ladder triggers if clean exit
takes > 10 s; the hard-cap prevents Cloud Run SIGKILL from cutting
us off mid-flush). Test routes stay behind the existing
`ENABLE_TEST_ROUTES=true` env-var flag (set only in dev's TF
`extra_env_vars`; staging + prod TF deliberately omit it per
§7.1's production-posture lock). D.6 confirmed the flag-gated
route is the right shape; no removal at Slice D close.

**Cold-start instrumentation (per ADR-HTTP-001 Condition 2 + SD3):**

`PROCESS_START_HR = performance.now()` is captured at module
evaluation time (`src/observability.ts`). A one-shot middleware on the
Hono app calls `recordColdStartOnce()` on every request; the first
call per instance computes `cold_start_ms = performance.now() -
PROCESS_START_HR` and emits it as both an OTel histogram metric
(`cold_start_ms`) and a structured log line (`marker:'d1-cold-start'`).
The 30-burst measurement script (`scripts/cold-start-burst.sh`) reads
the log line via Cloud Logging and cross-checks against Cloud Run's
`run.googleapis.com/container/startup_latencies` per SD3.

**Pass/fail ladders + reopen-ADR triggers** are in
`docs/planning/f02-slice-d-scope.md` §"D.1 pass/fail decision tree";
the convention does NOT duplicate them here. Operators running D.1
read both the planning doc (for the ladder) and this section (for
the prototype's runtime contract).

#### Production posture for control-plane Cloud Run services

Control-plane HTTP services in `apps/*-api/` follow this
`min_instances` posture per environment:

| Env     | `min_instances` | Rationale                                                                                                           |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| dev     | 0               | Preserves cold-start observability for re-measurement; cost-conscious; no production traffic.                       |
| staging | 1               | Eliminates platform-cold-start from the hot path; smoke-tests the production posture against actual deploy cadence. |
| prod    | 1               | Eliminates platform-cold-start from the operator-facing hot path.                                                   |

**Cost.** Cloud Run charges for min-instance idle time at ~50% of
active rate. For a 0.5 vCPU / 512 MB `tenant-lifecycle-shared`
baseline in `asia-south1`, idle cost is ~$5–10/month per service per
env. Phase 1 budget envelope absorbs this without revision.

**What this does.** Cold-start latency on Cloud Run is dominated by
container pull + Node 22 runtime spawn + ESM resolution (4–5 s
observed in D.1 measurement, vs ~100 ms framework-attributable cost
per ADR-HTTP-001 Condition 2 scope clarification).
`min_instances=1` keeps one warm instance per region permanently,
so any first request after an idle period hits a hot instance.

**What this does not do.** Burst traffic that exceeds the warm pool
still pays the platform-cold-start cost on the second-and-subsequent
instances. For Phase 1 control-plane services, this is acceptable —
admin operations are low-volume and infrequent. If a control-plane
service starts seeing burst-driven cold-start latency complaints,
the mitigation ladder is: lift `min_instances` further → image-
bundling pass to shrink the runtime image → eager-import audit on
the ESM dependency graph → eventually consider a different runtime.

**Implementation (D.4).** The forthcoming `tenant-cloud-run-service`
TF module exposes `min_instances` as an input, with mode-aware
defaults: dev=0, staging=1, prod=1. Per-env wiring in
`infra/terraform/envs/{dev,staging,prod}/` may override for specific
services that legitimately need different posture (e.g., a worker-
only service that scales to zero in production), but the default is
the table above and any deviation requires explicit justification in
the env module.

**Re-measurement trigger.** First Phase 2 production traffic. The
D.1 smoke samples (n=2; OTel 97–188 ms framework, Cloud Run native
4,567–5,031 ms platform) measured against scale-from-zero, which is
the dev path. Production traffic should never traverse that path on
the operator-facing hot path; if production metrics show otherwise,
revisit `min_instances` and the operational mitigations above.

**Cloud SQL connection model (per ADR-INFRA-005 Decision 11):**

The runtime SA `tenant-lifecycle-runtime-{env}` connects to Cloud SQL
via IAM auth — `cloudsql.iam_authentication = on` is the only active
path; the postgres superuser has no password, and the break-glass
secret is emergency-only. D.1's `apps/tenant-lifecycle-api/` uses
Cloud Run's native `--add-cloudsql-instances` connector (Unix socket
at `/cloudsql/{INSTANCE_CONNECTION_NAME}`); `pg.Pool`'s `password`
callback fetches OAuth tokens via `google-auth-library` so long-
running pools refresh tokens transparently.

**D.4 TF follow-up (blocking `/v1/tenants/{id}` only):** Slice C 7.6
provisioned the `tenant-lifecycle-runtime` SA but did not grant
Cloud SQL access. D.4 must add:

1. `roles/cloudsql.client` on the env project (network reach).
2. `roles/cloudsql.instanceUser` on the `cortex-{env}-postgres`
   instance (IAM-auth login).
3. A `google_sql_user` resource of `type = "CLOUD_IAM_SERVICE_ACCOUNT"`
   registering `tenant-lifecycle-runtime@<project>.iam` as a database
   user.
4. SQL grants (CONNECT on `cortex` DB, USAGE on `public` schema,
   SELECT/INSERT/UPDATE/DELETE on `tenant`, `tenant_kms_key`,
   `tenant_config_version`, `audit_event`, etc.) — applied via a
   migration in D.4.

Until D.4 lands these, `/v1/tenants/{id}` returns 500 on first DB
query. `/health` and `/v1/test/slow-5s` do NOT touch the DB; D.1
Conditions 2 + 3 measurement runs against those two endpoints
unchanged.

### 7.1.1 Rotation workflow shape `[F02-D.2]`

`tenants.rotateKeys(db, tenantId, ctx, options)` is the library entry
point. Single-transaction phase sequence (mirrors Slice B/C suspend /
resume / offboard / terminate boundaries) — KMS calls run inside the
txn so a KMS failure rolls back the row writes; the post-commit
schedule-destroy step is the one side effect outside the txn so a
rollback never orphans a destruction schedule.

| #   | Step                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `SELECT … FOR UPDATE` on the tenant row (concurrency guard; mirrors the §10.15 contention pattern).                                                                                                                                                                                                                                                             |
| 2   | Preflight: tenant exists; `status === 'ACTIVE'`. SUSPENDED / OFFBOARDING / TERMINATED → `TenantStatusError`.                                                                                                                                                                                                                                                    |
| 3   | Cooldown check: `trigger === 'scheduled'` AND `last_key_rotated_at` within 24 h → no-op (return current row); `'on_demand'` always proceeds. `errorOnCooldown=true` raises `TenantRotationCooldownError` instead of the silent no-op.                                                                                                                           |
| 4   | Resolve `tenant_kms_key.kms_key_resource_name` (the logical key path) and call `kmsAdmin.rotateCryptoKey` — `getCryptoKey` to capture the prior primary version, `createCryptoKeyVersion` to mint the new one, `updateCryptoKeyPrimaryVersion` to promote it. Returns `{ oldPrimaryVersion, newPrimaryVersion }` (version-qualified resource names).            |
| 5   | `UPDATE tenant_kms_key SET rotated_at = now()` (logical key resource name unchanged — only the underlying primary version increments).                                                                                                                                                                                                                          |
| 6   | `UPDATE tenant SET last_key_rotated_at = now(), updated_at = now()`.                                                                                                                                                                                                                                                                                            |
| 7   | `emitAuditEvent(tx, { action: TENANT_KEY_ROTATED, before_state: { kms_key_resource_name: oldPrimaryVersion }, after_state: { kms_key_resource_name: newPrimaryVersion }, payload: { trigger } })`. Workspace standard envelope; existing catalog action (do NOT register a new one). Caller actor preserved per ADR-LIFECYCLE-001 §5 (terminal-success events). |
| 8   | Post-commit: `kmsAdmin.scheduleCryptoKeyVersionDestroy(oldPrimaryVersion)`. On failure → `console.warn` + continue (rotation already committed; §7.5 manual-cleanup runbook covers recovery).                                                                                                                                                                   |

**Options shape:**

```ts
{
  trigger: 'scheduled' | 'on_demand',  // required
  errorOnCooldown?: boolean,           // default false
}
```

**Error contract:** `TenantValidationError` (invalid uuid / actor /
options); `TenantNotFoundError` (no row); `TenantStatusError` (status
≠ ACTIVE); `TenantRotationCooldownError` (only when
`errorOnCooldown=true` AND scheduled trigger AND within 24 h cooldown).

### 7.2 Dual-key overlap mechanics `[F02-D.2]`

In-flight encrypt/decrypt across a rotation cutover succeeds because
the application layer records the encrypting key version per payload
(`EncryptedPayload.keyResourceName`, recorded at encrypt time per the
Slice B §4.15 cleanup vector resolution). Decryption looks up the
recorded version, not the current primary. **The overlap window is
functionally infinite at the application layer** — old payloads
decrypt as long as their recorded version remains valid in KMS.

The KMS-side window is governed by the crypto-key's
`destroyScheduledDuration` config (set at crypto-key creation in
TF, locked to 30 days per SD6). When `tenants.rotateKeys` finishes,
it calls `kmsAdmin.scheduleCryptoKeyVersionDestroy(oldPrimaryVersion)`
which moves the version to `DESTROY_SCHEDULED` state; the actual
DESTROYED transition happens after the configured window. Within
the window the version remains DECRYPT-capable, so any in-flight
decrypt on a payload encrypted with that version continues to
succeed.

The 30-day window is **incident-recovery margin**, not a functional
read window. Operators recovering from an accidental rotation
(rollback within 30 days) call `gcloud kms keys versions restore`
on the old version. After the window expires, the version's key
material is permanently destroyed; payloads encrypted with it
become unrecoverable.

**Cross-tenant safety**: AAD-bound envelope encryption (the
`utf8(tenantId)` AAD per `@cortex/encryption`) means a payload's
ciphertext fails AEAD auth if decrypted under any tenant other than
the encrypting one. Rotation does not affect this — tenant binding
is the AAD, not the key version.

### 7.3 Rotation cadence + on-demand path `[F02-D.2]`

**Scheduled cadence (90-day target).** A periodic Cloud Tasks
dispatcher (D.4 wires the queue + dispatcher) enqueues rotation
tasks for every tenant where
`now() - tenant.last_key_rotated_at > 90 days`. The dispatcher uses
`taskId = 'rotate-{tenantId}'` for built-in dedup (per ADR-LIFECYCLE-001
§3 + planning-doc D5).

**On-demand path.** The HTTP endpoint
`POST /v1/tenants/{id}/rotate-keys` (D.3 ships this; tracked as
SD7 endpoint #9) lets operators trigger rotation outside the
90-day cadence. Direct library calls (`tenants.rotateKeys` with
`trigger: 'on_demand'`) bypass the cooldown.

**Operator runbook (emergency rotation).** If a tenant's key
material is suspected compromised:

1. Trigger the on-demand rotation:
   `POST /v1/tenants/{tenantId}/rotate-keys` (D.3) OR direct
   library call from a controlled environment.
2. Verify rotation completed via the audit chain:
   `SELECT * FROM audit_event WHERE tenant_id = '<id>' AND action = 'TENANT_KEY_ROTATED' ORDER BY occurred_at DESC LIMIT 1;`.
3. Confirm `tenant.last_key_rotated_at` advanced.
4. Inventory payloads encrypted with the prior version: any data
   path that recorded the old `keyResourceName` will continue to
   decrypt successfully for 30 days. Hard re-encryption (re-wrap
   under the new primary) is a separate workflow not yet shipped;
   tracked as a follow-up if a compromise scenario forces it.
5. Optional: restore the old version via
   `gcloud kms keys versions restore` if rotation was accidental
   (within the 30-day window).

### 7.4 Worker routes — OIDC + Cloud Tasks integration `[F02-D.2; D.4 extends; D.4.5 dual-pillars]`

D.4.5 added a second worker route (provisioning), turning §7.4 from
single-pillar (key-rotation) to dual-pillar. The shared pattern
(OIDC, payload format, observability, status-mapping) lives in
§7.4.0; per-route specifics live in §7.4.1 (key-rotation) and
§7.4.2 (provisioning). New worker routes inherit §7.4.0 + add their
own §7.4.N subsection.

#### 7.4.0 Shared pattern

**Route prefix:** `/v1/_workers/*` on `apps/tenant-lifecycle-api/`.
The prefix is the workspace convention for internal-only endpoints
— bypasses the user-tenant-context middleware (added to its
`skipPaths`). Tenant ID flows from the Cloud Tasks request body,
not the `x-cortex-tenant-id` header.

**OIDC validator** (extracted to
`apps/tenant-lifecycle-api/src/routes/workers/_shared/oidc.ts` at
D.4.5). Each route runs a per-route middleware that calls the
default validator (or a test stub injected via the route's
`validateOidc?` build option). Validator wraps `google-auth-library`'s
`OAuth2Client.verifyIdToken`. Failure modes: `missing-bearer-token`
/ `empty-bearer-token` / `wrong-issuer` / `wrong-issuer-email` /
`invalid-token` — all → 401 (Cloud Tasks treats as terminal, no
retry). The validator's `expectedSaEmail` is sourced at startup
from `config.CLOUD_TASKS_INVOKER_SA_EMAIL` (env-var pinned by D.4
to the runtime SA per Q-NEW-D-11 Option 1).

**Wire format: snake_case in body schema; camelCase in library
calls; transform at the route boundary.** Cloud Tasks dispatches
the payload as a base64-encoded JSON body verbatim. Convention:
the route's `dispatchCloudTask` callsite (in
`@cortex/tenant-context/src/tenants.ts` / similar) sends snake_case;
the route's zod body schema validates snake_case + the handler
transforms to camelCase before calling the library function.
Rationale: snake_case wire matches the user-facing API convention
(GET /v1/tenants/:id returns snake_case JSON); the library functions
take camelCase TS interfaces. Transform at the route boundary keeps
both surfaces idiomatic.

**Status mapping** (per the workspace error-mapper from D.1):

| Library throw                  | HTTP response | Cloud Tasks behavior     |
| ------------------------------ | ------------- | ------------------------ |
| `TenantValidationError`        | 400           | terminal (no retry)      |
| OIDC validation fail           | 401           | terminal                 |
| `TenantNotFoundError`          | 404           | terminal                 |
| `TenantStatusError`            | 409           | terminal                 |
| `TenantRotationCooldownError`  | 409           | terminal                 |
| Other / KMS / DB / GCS / smoke | 5xx           | retried per queue config |

The 4xx-terminal vs 5xx-retried distinction lets workers
deliberately fail-fast on logic errors (wrong status, missing row)
without burning the queue's retry budget. Transient infra blips
(DB timeout, KMS hiccup, smoke-test failure under transient
condition) re-throw plainly + Cloud Tasks retries per the queue
config.

**Cross-project artifact-registry pull (D.4-established
convention).** Cloud Run pulls images from
`sevyn8-cortex-shared/cortex-apps/<app>` (single registry plane per
ADR-INFRA-002). **Two** per-env IAM bindings are required for cross-
project pulls; each grants `roles/artifactregistry.reader` at the
repository level (not project level — narrowest viable scope):

1. **Runtime SA grant** — covers runtime image pulls (Cloud Run
   instance fetching the image as the service starts up). Wired as
   `google_artifact_registry_repository_iam_member.<workload>_apps_reader`
   with `member = "serviceAccount:${runtime_sa.email}"`.
2. **Cloud Run Service Agent grant** — covers deployment-time pulls
   (`gcloud run services update --image=<cross-project>` and the
   equivalent TF-side service create/update). The Service Agent is
   per-project, project-number-derived, Google-managed:
   `service-${project_number}@serverless-robot-prod.iam.gserviceaccount.com`.
   Wired as
   `google_artifact_registry_repository_iam_member.cloud_run_service_agent_apps_reader`
   with `member = "serviceAccount:service-${data.google_project.current.number}@serverless-robot-prod.iam.gserviceaccount.com"`.

Without (2), `gcloud run services update` fails with "Cloud Run
Service Agent must have permission to read the image". Without (1),
the runtime container fails to pull on first request. Both are
required; the runtime SA grant is NOT sufficient on its own. Future
control-plane workloads inherit the dual-grant pattern.

**Deploying a new control-plane workload (checklist).**

1. Add the workload package under `apps/<workload>/` (Hono +
   workspace deps; D.1 prototype shape).
2. In `apps/<workload>/Dockerfile`, target workspace-rooted COPY
   paths; build context = repo root.
3. In each env's `main.tf` (dev / staging / prod) append the D.4
   pattern: 7 IAM/resource declarations + 2 module instantiations
   (operator-emails IAM, cloudsql.client + instanceUser, sql_user,
   runtime-SA AR repo reader, Cloud Run Service Agent AR repo reader,
   queue if needed, `tenant-cloud-run-service` instantiation with
   `mode="shared"`).
4. Add 3 vars to each env's `variables.tf` (or a workload-specific
   subset): the workload's image URI, operator emails (re-use
   `var.operator_emails` if they're the same set), shared project ID
   (re-use `var.shared_project_id`).
5. Companion migration in `services/foundation/migrations/`
   granting the SQL-level perms the runtime role needs once
   `google_sql_user` lands the role. Idempotent DO block per the
   `0012_tenant_lifecycle_runtime_grants.sql` template — checks
   `pg_roles` before granting, skips if not yet provisioned.
6. Image bootstrap: `make image-bootstrap APP=<workload>` once
   before the first `tf-apply` (TF can't create a Cloud Run
   service without an image; bootstrap pushes the SHA-tagged
   image to `cortex-apps`, then operator sets
   `<workload>_image_uri` in `local.auto.tfvars`).
7. `make tf-plan-{dev,staging,prod}` clean diff, then apply.
8. `apps/<workload>/scripts/deploy-{env}.sh` for image SHA
   updates only (`gcloud run services update --image=...`); the
   service shape is TF-owned. NO `--service-account`, `--port`,
   `--cpu`, `--memory`, `--labels`, etc. — those flags fight TF on
   subsequent applies.

#### 7.4.1 Key rotation worker `[F02-D.2 initial; D.4 wired]`

**Route:** `POST /v1/_workers/key-rotation`. Inherits §7.4.0
shared pattern.

**Body schema** (validated via `@hono/zod-validator`):

```ts
{
  tenant_id: z.string().uuid(),
  trigger: z.enum(['scheduled', 'on_demand']),
}
```

**Actor attribution.** The worker route runs with a hardcoded
service actor (`{ type: 'service', id: 'cortex-tenant-lifecycle-worker' }`).
On-demand rotations from the HTTP API (D.3) carry the caller's
actor instead; the audit-chain payload's `actor_id` distinguishes
the two paths for forensic queries ("which rotations were
operator-driven vs scheduled?").

**Per-route status-mapping additions** (beyond §7.4.0 shared
table): `TenantRotationCooldownError` → 409 terminal (per the 24-h
on-demand cooldown).

**D.4 wiring (landed).**

- **Queue**: `key-rotation-queue` per env, declared as
  `module.cloud_tasks_key_rotation_queue` in
  `environments/{dev,staging,prod}/main.tf`. Module
  `infra/terraform/modules/cloud-tasks-queue` (existing; instantiated
  third time alongside `provisioning-queue` + `lifecycle-queue` from
  Slice C). `max_dispatches_per_second = 5` (halved vs. the others —
  KMS rotation is slow async work; default would saturate KMS
  quotas faster than the work drains). `max_attempts = 5`,
  `min_backoff = 10s`, `max_backoff = 300s`, `max_doublings = 5`
  per module defaults — backoff schedule
  `10s → 20s → 40s → 80s → 160s → 300s` covers the ~5 min KMS
  PERMISSION_DENIED propagation window after a fresh tenant_kms_key
  binding lands.
- **Dispatcher SA**: `tenant-lifecycle-runtime@<env>.iam.gserviceaccount.com`
  (Slice C-provisioned). Per Q-NEW-D-11 → Option 1, the same SA is
  the Cloud Tasks **dispatcher** AND the OIDC **audience** for
  inbound worker calls. Rationale: Phase 1 simplicity; AC01 (P2.1)
  splits via request-scoped identity. Marginal blast-radius is
  ~zero — the runtime SA already holds Cloud SQL write + KMS rotate
  - Storage objectAdmin; adding `cloudtasks.enqueuer` doesn't
    meaningfully extend reach. Audit logs collapse "runtime → self via
    Cloud Tasks" and "runtime → self direct" into the same
    `principalEmail`; AC01 distinguishes via request-scoped identity.
- **OIDC audience pinning**: the TF module
  (`tenant-cloud-run-service`) sets `CLOUD_TASKS_INVOKER_SA_EMAIL`
  to `var.runtime_sa_email` automatically. Worker route's OIDC
  middleware reads this env at startup (no per-request lookup);
  inbound `Authorization: Bearer <id-token>` whose `email` claim
  ≠ this value → 401 (terminal in Cloud Tasks). Tests inject a
  stub via the `validateOidc` build option.
- **Post-create timing tolerance** (`updateCryptoKeyPrimaryVersion`
  immediately after `createCryptoKeyVersion`): the new version may
  briefly return state `PENDING_GENERATION` before transitioning
  to `ENABLED`. The wrapper retries the `update` call with
  exponential backoff (200ms / 400ms / 800ms; max 3 attempts) on
  `FAILED_PRECONDITION`. Total worst-case cold path: ~1.4s of
  retries + the actual KMS work. Rotation worker's per-task SLA
  budget (5 minutes; see §7.5) absorbs this comfortably.

#### 7.4.2 Provisioning worker `[F02-D.4.5]`

**Route:** `POST /v1/_workers/provision`. Inherits §7.4.0 shared
pattern. Path matches the env-var (`PROVISIONING_WORKER_URL`,
TF-set) and the test-helper convention (D.3 era). Library function (already shipped in Slice A;
exported from `@cortex/tenant-context`):
`provisioningWorker(db, payload)`.

**Body schema** (validated via `@hono/zod-validator`; strict —
extra keys reject):

```ts
{
  tenant_id: z.string().uuid(),
  actor_type: z.enum(['service', 'user', 'system']),
  actor_id: z.string().min(1).max(255),
  actor_description: z.string().max(1024).optional(),
}
```

**Actor attribution.** The worker uses a hardcoded service actor
(`{ type: 'service', id: 'cortex-tenant-lifecycle' }`) for the
system-driven `TENANT_STATUS_CHANGED` rows it emits per transition.
The terminal-success `TENANT_PROVISIONED` event preserves the
ORIGINAL caller's actor (forwarded through the Cloud Tasks payload)
for forensic attribution — operators querying "who initiated the
provisioning of tenant X" get the user/service that called
`tenants.provision`, not the worker.

**State-machine drive.** Worker advances the tenant per
`ALLOWED_TRANSITIONS` (in `packages/tenant-context/src/tenants.ts`)

- ADR-LIFECYCLE-001 §1:

```
REQUESTED  →  (Enterprise: dedicated_db_approved gate; SA13)  →  PROVISIONING
PROVISIONING  →  (SA8 smoke test passes)                      →  READY
READY  →  (smoke test gates the flip; SA5)                    →  ACTIVE
```

Each transition runs in its own DB transaction (per
`provisioning-worker.ts` design — no super-transaction). Cloud
Tasks retry semantics + the SA11 pre-check make per-step
atomicity sufficient.

**Idempotency.** Cloud Tasks `taskId='provisioning-{tenant_id}'`
provides ~1-h dedup. The worker's SA11 pre-check covers the second
layer: status past `PROVISIONING` (READY/ACTIVE/SUSPENDED/
OFFBOARDING/TERMINATED) → no-op success; tenant doesn't exist (
post-cleanup) → no-op success. The route handler always returns
200 on the no-op paths; Cloud Tasks ack's + drops the task.

**Failure modes (SA10 hard rollback).**

- **Smoke-test failure** (substrate inconsistency — tenant row
  exists but `tenant_kms_key` doesn't, or similar). Worker invokes
  `cleanupFailedProvisioning` synchronously, then re-throws.
  Cleanup deletes `tenant_config_version` + `tenant_kms_key` +
  `tenant` rows in one transaction; ON DELETE RESTRICT FK ordering
  enforces. The throw surfaces as 500 to Cloud Tasks; subsequent
  retries pre-check (SA11), find no row, no-op success.
- **Transient errors** (DB timeout, KMS hiccup, network blip).
  Re-throw plainly (no cleanup). Cloud Tasks retries; substrate
  intact.
- **No FAILED state.** Per ADR-LIFECYCLE-001 §1 + planning-doc
  SA10. Operators retry by re-running `tenants.provision` with the
  same `external_id` after the cleanup runs.

**Per-route status-mapping additions** (beyond §7.4.0 shared
table): the smoke-test-failure cleanup-then-rethrow surfaces as
500 (Cloud Tasks retries → next attempt finds no tenant row →
200 no-op success → task ack'd + dropped).

**D.4.5 wiring (landed).**

- **Queue**: `provisioning-queue` per env (Slice C — pre-existing).
  Module defaults: `max_dispatches_per_second = 10`,
  `max_attempts = 5`, `min_backoff = 10s`, `max_backoff = 600s`.
  Higher dispatch rate than `key-rotation-queue` because most
  provisionings are quick (KMS substrate INSERT + smoke test ~1s
  on the warm path).
- **Dispatcher SA**: same as key-rotation —
  `tenant-lifecycle-runtime@<env>.iam.gserviceaccount.com`. Q-NEW-D-11
  Option 1 (single SA for runtime + dispatcher + OIDC subject).
  D.5 added the runtime SA's `roles/run.invoker` grant on the
  service explicitly to support this dispatch loop.
- **OIDC audience pinning**: identical to §7.4.1 —
  `CLOUD_TASKS_INVOKER_SA_EMAIL` env reads at route startup,
  matched against the inbound token's `email` claim.
- **Wire format change at D.4.5**: `tenants.provision`'s dispatch
  payload was camelCase (`tenantId`, `actorType`, ...) pre-D.4.5;
  flipped to snake_case (`tenant_id`, `actor_type`, ...) at D.4.5
  to match §7.4.0 wire convention. Any in-flight pre-D.4.5 tasks
  in `provisioning-queue` at apply time fail body validation → 400
  → Cloud Tasks treats as terminal, drops (acceptable; no production
  data).

### 7.5 Idempotency + failure recovery `[F02-D.2 initial; D.4 extends; D.4.5 + D.6 close]`

The provisioning worker (§7.4.2) follows the same shape:
SA11 pre-check (no-op when status past PROVISIONING) + Cloud Tasks
`taskId='provisioning-{uuid}'` dedup. Smoke-test failure invokes
`cleanupFailedProvisioning` (SA10 hard rollback) — distinct from the
key-rotation worker's failure path which has no analog (rotations
don't construct durable substrate).

**Re-dispatch idempotency.** Cloud Tasks may re-deliver a task
within its retry window (max 5 attempts; exponential backoff
30s → 5min → 30min per ADR-LIFECYCLE-001 §2). The 24-hour
cooldown on scheduled rotations handles this: the second + third

- … delivery within 24 h of the first successful rotation no-ops
  silently. The receiver returns 200 (not 409), so Cloud Tasks
  removes the task from the queue.

**Failure modes:**

| Failure                                 | Behavior                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KMS unavailable (transient)             | Inside txn → throw → txn rolls back → 5xx → Cloud Tasks retries.                                                                                                                                                          |
| KMS PERMISSION_DENIED                   | Same as above; Cloud Tasks retries until quota exhausted; dead-letter queue eventually surfaces it for operator triage.                                                                                                   |
| DB write fails inside txn               | txn rolls back; rotation didn't happen; 5xx; Cloud Tasks retries.                                                                                                                                                         |
| Audit emit fails inside txn             | txn rolls back; rotation didn't happen; 5xx; Cloud Tasks retries. Per audit-event-convention.md the audit row is in-txn.                                                                                                  |
| KMS scheduleDestroy fails (post-commit) | Rotation IS committed; `console.warn` logged with the orphaned version name. `tenant_kms_key.rotated_at` advanced; audit row emitted; new primary in place. Manual cleanup: `gcloud kms keys versions destroy <version>`. |
| OIDC validation fails                   | 401 → Cloud Tasks marks terminal failure → dead-letter queue.                                                                                                                                                             |

**Operator runbook (stuck rotation).**

1. Check the audit chain for `TENANT_KEY_ROTATED` event:
   - Present, `last_key_rotated_at` advanced → rotation succeeded;
     check Cloud Logging for any `console.warn` about
     scheduleDestroy failures.
   - Absent, `last_key_rotated_at` stale → rotation did not commit;
     check Cloud Tasks queue depth + dead-letter queue.
2. If a `scheduleDestroy` warning appears in logs, run the manual
   cleanup gcloud command above and re-verify version state with
   `gcloud kms keys versions list`.
3. If the dead-letter queue has tasks, decode the payload to
   recover `tenant_id` + `trigger`, investigate the underlying
   failure (typically KMS quota or IAM), and re-enqueue manually
   once the root cause is resolved.

**D.4 wiring (landed).**

- **Dead-letter handler**: Cloud Tasks doesn't ship a built-in
  dead-letter queue (DLQ) per ADR-LIFECYCLE-001 §2 — when
  `max_attempts` is exhausted the task is silently dropped. D.4
  substitutes a **synthetic DLQ via Cloud Logging**: every 5xx the
  worker emits at `level: error` with structured fields
  `{ event: 'KEY_ROTATION_TERMINAL_FAILURE', tenant_id, trigger,
attempt, error_class }`. A log-based metric
  (`cortex_key_rotation_terminal_failures_dev`, mirrored per env)
  counts these; the monitoring module's WARNING channel alerts on
  any non-zero count over a 1-hour rolling window. Deferred
  indefinitely (Phase 2+): a real DLQ-shaped table
  (`tenant_lifecycle_dlq`) with re-enqueue CLI. Phase 1 volume is
  low enough that log-based triage is sufficient. Tracked at
  future-roadmap §4.19; D.6 explicitly chose NOT to land this in
  Phase 1.
- **Per-task SLA monitoring**: a second log-based metric
  (`cortex_key_rotation_duration_p95_dev`) tracks worker-route
  latency at p95 across 1-hour windows. Alert threshold: 5 minutes
  (the queue's `max_backoff` × `max_attempts ÷ 2` budget). KMS
  PERMISSION_DENIED retries dominate the tail; alerting on p95
  (not p99) catches the case where >50 % of rotations are hitting
  the propagation race, while leaving the long-tail noise to
  per-task investigation. Wired via `monitoring` module's
  `log_based_metrics` input.
- **Cleanup-old-task pruner**: completed-task records in Cloud
  Tasks queues age out automatically after 90 days per Cloud Tasks
  retention. No explicit pruner needed for the queue itself. The
  KMS old-version cleanup (the "30-day overlap" path from §7.2) is
  driven by `tenant_kms_key.previous_key_destroy_scheduled_at` +
  the bootstrap `destroy_scheduled_duration = 2592000s` — versions
  scheduled for destroy at rotation time auto-destroy 30 days
  later. No CRON; KMS handles the timer. Operator runbook entry
  in §8.2 covers manual cleanup if `scheduleDestroy` failed
  post-commit.

### 7.6 HTTP API surface — 12 endpoints `[F02-D.3]`

The user-facing surface ships on `apps/tenant-lifecycle-api/`. All
endpoints under `/v1/tenants/*` go through Hono's path-param routing;
each handler binds via `withTenantDbClient(pool, id, fn)` inline
(per the §7.1 Cloud SQL connection model + Q-NEW-D-8). The
header-based `buildTenantContextMiddleware` from D.1 stays in place
with `rejectMissingTenant=false` so a future caller using
`x-cortex-tenant-id` gets binding for free, but the routes shipped
today don't depend on it.

**Endpoints (12).** Audit emissions reference catalog actions
registered in `packages/tenant-context/src/audit-actions.ts`. Status
codes follow the §7.4 / §7.5 error-mapping table — no new mappings
in D.3.

| Method | Path                                   | Library                      | Audit                          | Scope       |
| ------ | -------------------------------------- | ---------------------------- | ------------------------------ | ----------- |
| GET    | `/v1/tenants`                          | `tenants.list`               | none (read)                    | super-admin |
| POST   | `/v1/tenants`                          | `tenants.provision`          | TENANT_PROVISIONED (deferred¹) | open²       |
| GET    | `/v1/tenants/:id`                      | `tenants.get`                | none (read)                    | open²       |
| POST   | `/v1/tenants/:id/suspend`              | `tenants.suspend`            | TENANT_SUSPENDED               | open²       |
| POST   | `/v1/tenants/:id/resume`               | `tenants.resume`             | TENANT_STATUS_CHANGED          | open²       |
| POST   | `/v1/tenants/:id/offboard`             | `tenants.offboard`           | TENANT_OFFBOARDING_STARTED     | open²       |
| POST   | `/v1/tenants/:id/terminate`            | `tenants.terminate`          | TENANT_TERMINATED              | open²       |
| POST   | `/v1/tenants/:id/force-terminate`      | `tenants.forceTerminate`     | TENANT_FORCE_TERMINATED        | super-admin |
| POST   | `/v1/tenants/:id/rotate-keys`          | `tenants.rotateKeys`         | TENANT_KEY_ROTATED             | open²       |
| POST   | `/v1/tenants/:id/legal-holds`          | `legalHolds.set`             | LEGAL_HOLD_SET                 | open²       |
| DELETE | `/v1/tenants/:id/legal-holds/:hold_id` | `legalHolds.release`         | LEGAL_HOLD_RELEASED            | open²       |
| POST   | `/v1/tenants/:id/approve-dedicated-db` | `tenants.approveDedicatedDb` | TENANT_DEDICATED_DB_APPROVED   | super-admin |

¹ TENANT_PROVISIONED emits when the worker advances PROVISIONING →
READY (worker actor); the HTTP create call emits TENANT_CREATED +
TENANT_KMS_KEY_BOUND (and optionally TENANT_CONFIG_VERSION_CREATED)
synchronously per `tenants.create` precedent.

² **Open** in Phase 1 = "deny-by-default at the SD8 Cloud Run
invoker IAM floor; per-method gates ship with AC01." The Phase 1
super-admin endpoints are wrapped with `requireSuperAdmin()` — a
named, no-op middleware whose only purpose is to mark the
extension point AC01 will replace. Real per-method enforcement is
not in D.3.

**Naming + envelope conventions.**

- Path patterns: `/v1/tenants` (collection), `/v1/tenants/:id`
  (resource), `/v1/tenants/:id/{action}` (action verb in path).
  REST-correct DELETE for legal-hold release (idempotent;
  204 No Content).
- Body wire format: `snake_case` (matches the spec text + the
  `audit_event.payload` JSONB shape per audit-event-convention.md).
  Library functions use camelCase internally; routes do the
  snake↔camel translation explicitly at the boundary.
- Status codes per §7.4 error-mapping table:
  - 200 OK — happy path for read + state-change endpoints.
  - 201 Created — `legalHolds.set` (new resource).
  - 202 Accepted — `tenants.create` (workflow runs async via
    Cloud Tasks per ADR-LIFECYCLE-001).
  - 204 No Content — `legalHolds.release` (idempotent delete).
  - 400 — TenantValidationError + zod schema rejections.
  - 401 — OIDC validation failure (worker route only; not D.3).
  - 404 — TenantNotFoundError.
  - 409 — TenantStatusError, TenantRotationCooldownError,
    TenantLegalHoldError, TenantGraceNotElapsedError.
  - 5xx — uncategorized (DB transient, KMS unavailable). Cloud
    Tasks retries on 5xx; clients retry per their own policy.

**On-demand vs scheduled rotation actor distinction.** The HTTP
`POST /v1/tenants/:id/rotate-keys` path uses the caller actor
(Phase 1 placeholder: `{ type: 'service', id:
'cortex-tenant-lifecycle-api' }`). The Cloud Tasks worker route at
`/v1/_workers/key-rotation` (D.2) uses
`cortex-tenant-lifecycle-worker`. Forensic queries filter on
`actor_id` to disambiguate operator-initiated vs scheduled
rotations.

**Operator runbook (curl).**

```bash
# All examples assume the service URL is in $URL and an identity
# token (per SD8 Cloud Run invoker IAM) is in $TOKEN:
URL=$(gcloud run services describe tenant-lifecycle-shared \
  --project=sevyn8-cortex-dev --region=asia-south1 \
  --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)
H="Authorization: Bearer $TOKEN"

# Read: tenant by id
curl -sH "$H" "$URL/v1/tenants/$TENANT_ID"

# List (super-admin)
curl -sH "$H" "$URL/v1/tenants?limit=20&offset=0"

# Create
curl -sH "$H" -X POST "$URL/v1/tenants" \
  -H 'content-type: application/json' \
  -d '{"external_id":"acme","display_name":"Acme","tier":"STANDARD"}'

# Suspend
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/suspend" \
  -H 'content-type: application/json' \
  -d '{"reason":"compliance review SEC-1234"}'

# Resume
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/resume" \
  -H 'content-type: application/json' -d '{}'

# Offboard
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/offboard" \
  -H 'content-type: application/json' \
  -d '{"grace_period_days":30}'

# Terminate (after grace elapses; otherwise 409)
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/terminate" \
  -H 'content-type: application/json' -d '{}'

# Force-terminate (super-admin; bypasses grace + legal hold)
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/force-terminate" \
  -H 'content-type: application/json' \
  -d '{"reason":"compliance escalation"}'

# Rotate keys (on-demand; bypasses 24-h cooldown)
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/rotate-keys" \
  -H 'content-type: application/json' -d '{}'

# Set legal hold (scope=tenant)
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/legal-holds" \
  -H 'content-type: application/json' \
  -d '{"scope":"tenant","reason":"litigation","set_by_user_id":"legal-team-1"}'

# Release legal hold (idempotent; 204)
curl -sH "$H" -X DELETE "$URL/v1/tenants/$TENANT_ID/legal-holds/$HOLD_ID" \
  -H 'content-type: application/json' \
  -d '{"released_by_user_id":"legal-team-1"}'

# Approve Enterprise dedicated-DB provisioning (super-admin)
curl -sH "$H" -X POST "$URL/v1/tenants/$TENANT_ID/approve-dedicated-db" \
  -H 'content-type: application/json' \
  -d '{"approved_by_user_id":"cfo-1","notes":"FIN-42"}'
```

**Cross-references.**

- §7.4 error-mapping table is THE contract for library-throw →
  HTTP-status. D.3 inherits verbatim; no extensions.
- §7.5 failure-mode table covers the worker route's stuck-rotation
  runbook; equivalent operator runbooks for the other endpoints
  live in §4 (provisioning) / §5 (suspend/resume cascade) /
  §6 (offboard/terminate).
- §7.7 (landed at D.5, commit `c4fdc41`) documents the platform-
  layer invoker IAM allowlist; AC01 layers per-method authz on top
  via the `requireSuperAdmin()` placeholder seam D.3 added.

§7.7 (IAM + invoker authz) shipped at D.5; §7.8 (forensic queries)
ships at D.6. Q-NEW-D-12 resolved.

### 7.7 IAM + invoker authz `[F02-D.5]`

**Status: landed 2026-05-08 (commit `c4fdc41`).** Gate evidence:
`docs/planning/d5-gate-evidence.md` (3 live curls + IAM-policy
snapshot).

#### 7.7.1 Invoker IAM model

Cloud Run platform-layer authz floor per planning-doc SD8:
**deny-by-default + explicit allowlist**. The service has NO
`--allow-unauthenticated` flag set and NO `allUsers` member; every
caller must hold `roles/run.invoker` to reach the Hono app at all.

The allowlist has three principal classes per env:

| Principal                                             | Member            | Purpose                                                                                                                                           |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cortex-tf-admin@sevyn8-cortex-{env}` SA              | `serviceAccount:` | Operator + integration-test path via impersonation flow                                                                                           |
| `tenant-lifecycle-runtime@sevyn8-cortex-{env}` SA     | `serviceAccount:` | Cloud Tasks → Cloud Run worker-route dispatches (Q-NEW-D-11 Option 1: dispatcher + runtime are the same SA, so the service must allowlist itself) |
| `var.operator_emails` (currently `[amit@sevyn8.com]`) | `user:`           | Break-glass + manual-curl paths; reuses the same list as the runtime-SA `iam.serviceAccountUser` grant from D.4                                   |

The runtime SA grant is what makes D.2's deployed
`POST /v1/_workers/key-rotation` reachable — Cloud Tasks dispatches
with an OIDC ID token whose subject is the runtime SA, target
audience is the worker URL. Without the self-allowlist, every
dispatched task would return 403 from the platform layer before
reaching the Hono OIDC validation. D.4.5's future provisioning
worker uses the same path.

#### 7.7.2 TF wiring shape

**Module-level** (`infra/terraform/modules/tenant-cloud-run-service/`):

- `var.invoker_service_accounts` — list of SA emails (default `[]`).
  Module emits one `google_cloud_run_v2_service_iam_member` per
  entry with `member = "serviceAccount:${each.value}"`.
- `var.invoker_user_emails` — list of user emails (default `[]`).
  Module emits one `google_cloud_run_v2_service_iam_member` per
  entry with `member = "user:${each.value}"`.

Two resources rather than one with a coalesced `for_each` because
the principal-type prefix (`serviceAccount:` vs `user:`) differs
per identity class — clearer to reviewers, no string-mangling at
the `for_each` boundary. Standard `google_*_iam_member` (additive)
pattern per CLAUDE.md "Terraform conventions"; never
`*_iam_binding` / `*_iam_policy` (authoritative).

**Env-level** (e.g., `infra/terraform/environments/dev/main.tf`):

```hcl
invoker_service_accounts = [
  "cortex-tf-admin@${var.project_id}.iam.gserviceaccount.com",
  google_service_account.tenant_lifecycle_runtime.email,
]
invoker_user_emails = var.operator_emails
```

The `cortex-tf-admin-{env}` reference is a literal-string
interpolation rather than a TF data source: bootstrap creates the
SA with a deterministic name, and env-level main.tf doesn't manage
its lifecycle. Hardcoded string is the workspace pattern.

#### 7.7.3 The 3-case integration test

`apps/tenant-lifecycle-api/test/integration/iam-authz.integration.spec.ts`
shells out to `gcloud auth print-identity-token` and hits the
LIVE Cloud Run dev URL. NOT in-process via `app.request()` — the
whole point is exercising the Google front-end's invoker-IAM gate,
which never reaches the Hono app for the deny case.

| Case | Token                                                                                                           | Expected | What it proves                                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | none (no `Authorization` header)                                                                                | 403      | Cloud Run platform deny — no SA / user / `allUsers` member can call without a valid invoker grant                                                                                                       |
| B    | `gcloud auth print-identity-token` (operator user identity)                                                     | 200      | `user:` invoker grant works; default audience matched against user-grant principal type                                                                                                                 |
| C    | `gcloud auth print-identity-token --impersonate-service-account=cortex-tf-admin-{env} --audiences=$SERVICE_URL` | 200      | SA impersonation flow works (operator → tokenCreator on cortex-tf-admin via cortex-admins group → mint OIDC token → service accepts because `serviceAccount:cortex-tf-admin-dev` has the invoker grant) |

**Skip semantics:** the spec is `describe.skipIf(SKIP)` where
`SKIP = !process.env.CORTEX_INTEGRATION_TESTS`. Matches the P0.7
precedent (`packages/secrets/test/integration/`). Operator runs
manually:

```bash
CORTEX_INTEGRATION_TESTS=1 \
CORTEX_TENANT_LIFECYCLE_URL=$(gcloud run services describe \
  tenant-lifecycle-shared --project=sevyn8-cortex-dev \
  --region=asia-south1 --format='value(status.url)') \
  pnpm vitest run test/integration/iam-authz.integration.spec.ts
```

Not run in CI today — CI lacks `gcloud auth` wiring (D.6 may
address via WIF). For Phase 1, the 3 manual curls in
`docs/planning/d5-gate-evidence.md` are the authoritative
acceptance evidence; the spec is the automation-ready form.

#### 7.7.4 What's deliberately NOT in D.5

- **Per-method authz** — which roles can call which
  `/v1/tenants/*` endpoint. The §7.6 endpoint-table "Scope" column
  (`open²` vs `super-admin`) is the seam, but the actual gate stays
  the Phase-1 placeholder (`defaultSuperAdminGuard` no-op + Cloud
  Run invoker IAM floor). AC01 (P2.1) replaces both with Auth0
  role membership checks.
- **`allUsers` removal** — the Cortex Cloud Run service was never
  configured with `--allow-unauthenticated` in any env. There's no
  legacy binding to remove.
- **Per-tenant deploy IAM** — when ENTERPRISE per-tenant Cloud Run
  services land (post-ADR-INFRA-005 swap), each will have its own
  invoker allowlist scoped to that tenant's operator + dispatcher
  identities. Module's `mode="tenant"` shape supports the same
  invoker variables; env-level wiring will populate per-tenant.

#### 7.7.5 Forward-looking (post-D.6 + AC01)

CI integration of the 3-case integration test under WIF was
considered for D.6 + deferred. The 4-step sketch (when triggered):
WIF allows GitHub Actions to impersonate `cortex-ci-test-shared`
SA → that SA holds `tokenCreator` on `cortex-tf-admin-dev` → CI
mints impersonation ID tokens → 3-case test runs. Roadmap §4.5
tracks the `cortex-ci-test-shared` provisioning trigger as "first
GCP-accessing CI workflow needs to call GCP APIs". D.6 closed
without wiring this — operator-runnable (the
`CORTEX_INTEGRATION_TESTS=1` flag) is sufficient for Phase 1.

AC01 layers per-method authz on top of D.5's invoker floor. Cloud
Run IAM stays as the platform-level deny; per-method Auth0-role
checks gate inside the app. The two compose: a request needs both
(a) a token from a member of the invoker allowlist AND (b) the
right Auth0 role for the route's required permission.

### 7.8 Forensic queries `[F02-D.6]`

The audit chain (`audit_event` table, ADR-DB-003) is the
primary forensic surface for tenant lifecycle. Three query
patterns cover the operationally-useful 80% of lifecycle audit
investigation; SQL below references the actual schema (per
migration 0004 `audit_event` + 0008 actor-type constraint).

All queries below run against the `cortex` database; require
session-bound `app.tenant_id` for RLS-protected reads (currently
`audit_event` writes are RLS-protected — ADR-DB-003; reads via
service-role bypass at the operator session). Use `withTenantDbClient`
or `set_config('app.tenant_id', '<uuid>', true)` per CLAUDE.md
"Database conventions".

#### 7.8.1 Provisioning timeline for a tenant

When did this tenant get created, when did it reach READY,
who initiated it?

```sql
SELECT
  occurred_at,
  action,
  actor_type,
  actor_id,
  payload->'after_state'->>'status' AS new_status
FROM audit_event
WHERE tenant_id = '<tenant-uuid>'
  AND action IN ('TENANT_CREATED', 'TENANT_PROVISIONED', 'TENANT_STATUS_CHANGED')
ORDER BY occurred_at ASC, event_id ASC;
```

The `event_id` tiebreaker keeps within-microsecond events
deterministic per the `audit_event_tenant_time` index ordering.
`TENANT_CREATED` carries the original caller actor; `TENANT_PROVISIONED`
preserves it through the worker (per §7.4.2 actor-attribution);
intermediate `TENANT_STATUS_CHANGED` rows carry the worker's
service actor (`cortex-tenant-lifecycle`).

#### 7.8.2 Termination chain (with grace + actor)

When was this tenant terminated, what was the grace period,
who triggered (operator vs. forced)?

```sql
SELECT
  ae.occurred_at,
  ae.action,
  ae.actor_type,
  ae.actor_id,
  ae.payload->'before_state'->>'status' AS prior_status,
  ae.payload->'before_state'->>'offboarding_grace_until' AS grace_until,
  ae.payload->>'reason' AS reason
FROM audit_event ae
WHERE ae.tenant_id = '<tenant-uuid>'
  AND ae.action IN (
    'TENANT_OFFBOARDING_STARTED',
    'TENANT_TERMINATED',
    'TENANT_FORCE_TERMINATED'
  )
ORDER BY ae.occurred_at ASC, ae.event_id ASC;
```

`TENANT_FORCE_TERMINATED` is the distinct compliance event for
super-admin override (per Slice C SC2 + audit-actions.ts:52);
filtering by action surfaces "tenant terminated despite an active
hold or before grace" without parsing payload metadata.

#### 7.8.3 Key rotation history per tenant

When did keys rotate, was it scheduled or on-demand, what was
the resource-name transition?

```sql
SELECT
  occurred_at,
  actor_type,
  actor_id,
  payload->'before_state'->>'kms_key_resource_name' AS old_key,
  payload->'after_state'->>'kms_key_resource_name' AS new_key,
  payload->>'trigger' AS trigger
FROM audit_event
WHERE tenant_id = '<tenant-uuid>'
  AND action = 'TENANT_KEY_ROTATED'
ORDER BY occurred_at DESC, event_id DESC;
```

`actor_id = 'cortex-tenant-lifecycle-worker'` flags scheduled
rotations (worker route per §7.4.1); other `actor_id` values flag
on-demand rotations from the HTTP API per §7.6's POST
`/v1/tenants/:id/rotate-keys`.

#### 7.8.4 Index notes

The single index `audit_event_tenant_time (tenant_id, occurred_at
DESC, event_id)` covers all three queries above efficiently — they
all filter by `tenant_id` then range-scan time. Queries spanning
multiple tenants (e.g., "all `TENANT_TERMINATED` across the
fleet") would benefit from an additional `(action, occurred_at
DESC)` index; tracked at future-roadmap §4.11 ("audit_event
indexes for SCR-22 elevated-review queries"). Phase 1 fleet size
(< 10 tenants) makes the existing index sufficient.

#### 7.8.5 What's deliberately NOT here

- **Cross-tenant aggregations** (e.g., "fleet-wide rotation
  cadence histogram"). Operationally interesting, but Phase 1
  volume doesn't justify the schema work + the RLS-bypass surface
  it'd require. Owner-phase: F04 (Configuration Plane) reporting,
  or whenever fleet size makes them necessary.
- **Hash-chain verification** (re-compute `curr_hash` from
  payload + prev_hash to detect tampering). Tracked at future-
  roadmap §5.3 "verify_chain audit chain integrity verifier",
  first-consumer-driven.
- **Replay / event sourcing** (reconstruct tenant state from
  events). Tenant table itself is the canonical state; audit_event
  is the audit log, not an event store.

Resolves Q-NEW-D-12 (convention §7 incremental extension; §7.8
lands D.6's contribution; Slice D §7 closes here).

## 8. Operational patterns

Cross-cutting patterns operators encounter in production. Specific
workflows reference these from §4–§7.

### 8.1. Retry semantics

Cloud Tasks retries failed dispatches per queue config (max 5
attempts; exponential backoff 30s → 5min → 30min). Workers
participate by:

- **Re-throwing transient errors plainly** (DB timeout, KMS hiccup,
  network blip, non-deterministic GCP API failure). Cloud Tasks
  retries; no cleanup; substrate intact.
- **Calling cleanup + re-throwing for known-unrecoverable errors**
  (smoke-test failure per SA14). Cleanup deletes substrate; re-throw
  surfaces the failure to Cloud Tasks for ops visibility. Subsequent
  retries against the now-deleted tenant pre-check (SA11) and no-op.

The asymmetry is deliberate: transient errors deserve retry;
substrate inconsistency does not.

### 8.2. Manual approval workflow (Enterprise)

See §4.6 for the step-by-step. Summary: operator UPDATEs
`dedicated_db_approved=true` then re-enqueues the Cloud Task. SA13
locked the push-style re-enqueue pattern.

**Upgrade trigger:** when Enterprise volume ≥ ~10/month, automate
the approval gate (cost-policy validation, signature-based approval
workflow, etc.). Until then, manual UPDATE + re-enqueue is the
operator-visible path.

### 8.3. Legal-hold management (Q-OPEN-3)

**Setting a hold (Phase 1):**

```sql
UPDATE tenant SET legal_hold = true WHERE id = $1;
```

Direct DB UPDATE today (no audit emit; Slice C TBD as the workflow
matures). Phase 2 (Slice C migration 0011) ships a `legal_hold`
table with explicit `set_by_user_id` + `reason` columns; until
then, intent is recorded out-of-band (legal team's ticket, etc.).

**Releasing a hold:**

```sql
UPDATE tenant SET legal_hold = false WHERE id = $1;
```

**Termination flow:** `tenants.terminate` checks `tenant.legal_hold = true`;
refuses if set. Super Admin override via `tenants.forceTerminate`
(Slice C) provides escape hatch.

### 8.4. Failed provisioning recovery

Smoke-test failure already triggers `cleanupFailedProvisioning`
automatically (per SA14; see §4.4). Operator runbook for the
post-cleanup state:

1. Read Cloud Tasks dead-letter queue (or look at the failed
   provisioning task's response in Cloud Tasks logs) to understand
   why smoke-test failed.
2. Verify `tenants.get(db, tenantId)` returns `TenantNotFoundError`
   (cleanup ran).
3. Investigate the root cause — typically a substrate inconsistency
   (e.g., manual `tenant_kms_key` row deletion, or an interrupted
   `tenants.create` that didn't finish before the worker fired).
4. Once the root cause is fixed, resubmit via `tenants.provision`
   with the same `external_id` (slot was freed by cleanup).
5. Verify the new provisioning advances normally (`status='ACTIVE'`
   end-state).

Edge case: if `cleanupFailedProvisioning` itself failed (rare —
RLS bind missing, FK constraint violation in non-RESTRICT direction,
etc.), substrate may be partial. Operator triages by inspecting
each table directly (`tenant`, `tenant_kms_key`, `tenant_config_version`)
and running `cleanupFailedProvisioning` again or doing manual
DELETEs as a last resort.

### 8.5. Dead-letter queue triage

After max attempts (5), Cloud Tasks marks the task permanently
failed and dispatches to a dead-letter queue. P0.6 observability
stack alerts on `cloudtasks.googleapis.com/queue/dead_letter_count > 0`.

**Triage runbook:**

1. Check Cloud Tasks dead-letter queue: `gcloud tasks list --queue=provisioning-dead-letter-queue --project=sevyn8-cortex-{env}`.
2. For each dead-lettered task, decode the payload to get `tenantId`.
3. Check `tenants.get(db, tenantId).status`:
   - **Tenant exists at PROVISIONING:** substrate may be inconsistent
     OR transient KMS / DB unavailable. Investigate; consider
     `cleanupFailedProvisioning` + resubmit.
   - **Tenant doesn't exist:** cleanup already ran (likely
     smoke-test path triggered it). Operator action: investigate
     why the workflow tried 5 times and failed, fix root cause,
     resubmit.
   - **Tenant past PROVISIONING (READY/ACTIVE/etc.):** worker
     pre-check should have no-op'd. Dead letter with this state is
     anomalous; investigate Cloud Tasks logs for clues.
4. Manually re-dispatch if appropriate: `gcloud tasks create-http-task`
   with the same payload + taskId pattern.

### 8.6. Concurrency model

Per Q-OPEN-1: 10 concurrent dispatches per queue. Per-tenant
serialization via `taskId` dedup — only one workflow per `(verb,
tenantId)` in flight at a time. No distributed lock needed; Cloud
Tasks' built-in dedup primitive suffices.

Two operators triggering the same operation (e.g., both calling
`tenants.provision` for the same `external_id`) hit the
`tenant.external_id UNIQUE` constraint at the `tenants.create`
layer — one wins, the other gets a 23505 unique-violation error.
The losing call doesn't dispatch a Cloud Task. No race at the
queue layer.

## 9. Audit emission patterns

Hybrid catalog per planning-doc D6: domain actions for
irreversible / compliance-relevant events; generic
`TENANT_STATUS_CHANGED` for reversible state transitions.

### 9.1. Domain actions

| Action                          | Verb   | Emitted by                              | Captures                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANT_CREATED`                | CREATE | `tenants.create`                        | Initial substrate. `after_state`: external_id, display_name, tier, status. Caller actor.                                                                                                                                                                                                |
| `TENANT_KMS_KEY_BOUND`          | CREATE | `tenants.create`                        | KMS key resource name binding. `after_state.kms_key_resource_name`. Caller actor.                                                                                                                                                                                                       |
| `TENANT_CONFIG_VERSION_CREATED` | CREATE | `tenants.create` (conditional)          | Initial config v=1 (only if `initialConfig` supplied). `after_state.version_number`, `after_state.config`. Caller actor.                                                                                                                                                                |
| `TENANT_PROVISIONED`            | CREATE | `provisioningWorker` (terminal-success) | Provisioning workflow completed. `after_state.status='READY'`. **Caller actor preserved** for forensic attribution.                                                                                                                                                                     |
| `TENANT_UPDATED`                | UPDATE | `tenants.update`                        | Mutable-field changes (display_name in Slice A). `before_state` + `after_state` capture the delta.                                                                                                                                                                                      |
| `TENANT_STATUS_CHANGED`         | UPDATE | `tenants.setStatus`                     | Generic state transition. `before_state.status` + `after_state.status`. Used for symmetric reversibles + worker-driven advances.                                                                                                                                                        |
| `TENANT_OFFBOARDING_STARTED`    | UPDATE | `tenants.offboard` `[F02-C]`            | Offboarding initiated. `after_state.grace_until`. Caller actor.                                                                                                                                                                                                                         |
| `TENANT_TERMINATED`             | DELETE | `tenants.terminate` `[F02-C]`           | Soft-retain tombstone + cascade. `before_state` captures final tenant shape + `kms_key_resource_name`; `payload.cascade_steps` records per-step status (per Q-NEW-C5). Caller actor.                                                                                                    |
| `TENANT_FORCE_TERMINATED`       | DELETE | `tenants.forceTerminate` `[F02-C]`      | Super Admin override. Same shape as `TENANT_TERMINATED` plus `payload.reason` + `payload.override_metadata.{skipped_legal_hold, skipped_grace_period, active_legal_hold?, tenant_legal_hold_boolean_was_set?}`. Distinct action per SC2 lock for compliance grep-ability. Caller actor. |
| `LEGAL_HOLD_SET`                | CREATE | `legalHolds.set` `[F02-C]`              | Compliance assertion: hold placed on a tenant scope. `after_state` captures scope, reason, set_by_user_id, plus record_id or data_class when applicable. Caller actor.                                                                                                                  |
| `LEGAL_HOLD_RELEASED`           | DELETE | `legalHolds.release` `[F02-C]`          | Compliance assertion: hold released. `before_state` captures the now-released hold's pre-release shape; `payload.released_by_user_id` and optional `release_reason`. DELETE verb is semantic ("assertion deleted"); the row is soft-retained for the historical record. Caller actor.   |
| `TENANT_KEY_ROTATED`            | UPDATE | `tenants.rotateKeys` `[F02-D]`          | Key rotation. `before_state.kms_key_resource_name` + `after_state.kms_key_resource_name`. Caller actor.                                                                                                                                                                                 |
| `TENANT_CONFIG_VERSION_UPDATED` | UPDATE | future config-update workflow           | Config mutation post-creation. `before_state` (prior config_json) + `after_state` (new config_json + version_number). Caller actor.                                                                                                                                                     |

### 9.2. Generic TENANT_STATUS_CHANGED

Used for symmetric reversible transitions:

- ACTIVE → SUSPENDED (suspend) and SUSPENDED → ACTIVE (resume).
- PROVISIONING → READY and READY → ACTIVE (worker-driven; service actor).
- REQUESTED → PROVISIONING (worker-driven; service actor).

The `before_state` / `after_state` payload captures the transition.
Readers reconstruct the timeline by sorting on `occurred_at` and
threading the `before` → `after` chain. Distinct from the domain
actions which are one-shot terminal-success events.

### 9.3. Actor attribution rule

| Event class                                                                                                                                                                  | Actor source                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Substrate emissions (`TENANT_CREATED`, `TENANT_KMS_KEY_BOUND`, `TENANT_CONFIG_VERSION_CREATED`)                                                                              | Caller actor — flows through from `tenants.provision` / `tenants.create` invocation.                                     |
| Worker-driven status transitions (`TENANT_STATUS_CHANGED` from worker)                                                                                                       | Service actor: `{type: 'service', id: 'cortex-tenant-lifecycle'}`.                                                       |
| Terminal-success / compliance domain events (`TENANT_PROVISIONED`, `TENANT_OFFBOARDING_STARTED`, `TENANT_TERMINATED`, `TENANT_KEY_ROTATED`, `TENANT_CONFIG_VERSION_UPDATED`) | Caller actor preserved — payload in the worker dispatch carries the original caller's identity for forensic attribution. |
| User-triggered transitions (`TENANT_UPDATED`, `TENANT_STATUS_CHANGED` from `tenants.setStatus` called by an operator)                                                        | Caller actor.                                                                                                            |

The split keeps the audit chain forensically useful: "who caused
this lifecycle change?" reads from terminal events; "what did the
system do internally?" reads from `TENANT_STATUS_CHANGED` rows.

### 9.4. Hash chain integrity

`audit_event` chain integrity per ADR-AU-001 + ADR-DB-003: each
row's `curr_hash` includes the prior row's `curr_hash` for the same
tenant. Chain verification (when implemented) detects any mutation
or fork.

`cleanupFailedProvisioning` does NOT emit — not because the chain
integrity would break (it wouldn't; the table is append-only by
trigger), but because the cleanup is internal hygiene (the tenant
never went public). Audit-chain consumers see TENANT_CREATED +
TENANT_KMS_KEY_BOUND for failed provisionings without a
TENANT_PROVISIONED follow-up; that's the recommended forensic
signature for "tried and was cleaned up" (per §4.7).

### 9.5. Caller-supplied actor flow

```typescript
// Caller (HTTP handler, ops script, etc.) passes ctx.actor.
await tenants.provision(db, input, {
  actor: { type: 'user', id: 'operator@sevyn8.com', description: 'Manual provisioning via SCR-24' },
});

// tenants.provision threads ctx.actor through tenants.create:
// → TENANT_CREATED audit row carries actor_id='operator@sevyn8.com'.
// tenants.provision dispatches Cloud Task with payload.actorType / actorId / actorDescription:
// → Worker reconstructs ctx.actor from payload.
// → TENANT_PROVISIONED audit row carries actor_id='operator@sevyn8.com'.
```

The service actor `cortex-tenant-lifecycle` is the §4.14 hardcoded
fallback for emissions where no caller is identifiable (the worker's
own state advances). AC01 will swap this to a request-scoped resolver
when it ships.

## 10. Future swaps

Tracked items that this convention doc anticipates but doesn't yet
implement. Each has a planned trigger.

### 10.1. Per-tenant Cloud SQL provisioning `[F02-C / Slice C dependency]`

- Enterprise tenants get dedicated Cloud SQL instances per
  ADR-COMPUTE-001 + ADR-INFRA-005.
- Provisioning workflow extends: between PROVISIONING and READY,
  spin up dedicated Cloud SQL → run tenant-scoped migrations →
  bind to tenant via a new `tenant.cloud_sql_instance` column
  (Slice C migration adds this) → smoke test against the new
  instance.
- Approval gate (`dedicated_db_approved=true`) gates this step.
- Acceptance criterion (spec §1): Enterprise provisioning <30 min
  end-to-end including dedicated Cloud SQL allocation.

### 10.2. AC01 actor migration `[F02 → AC01 boundary]`

- Slice A workflows hardcode `cortex-tenant-lifecycle` as the
  service actor (§4.14 pattern reproduction; same as
  `cortex-encryption` in `@cortex/encryption`).
- AC01 (P2.1) ships agent identities; lifecycle workers acquire
  actor identity via AC01 API rather than hardcode.
- Migration: §9 actor attribution rule extends to "AC01-resolved
  agent identity for service-attributed events." Hardcoded actor
  becomes an AC01 fallback when async-local context is missing.

### 10.3. Cloud Tasks client extraction `[Phase 2+]`

- Cloud Tasks dispatch utility (`cloud-tasks.ts`) currently inlined
  in `@cortex/tenant-context` per planning-doc SA9.
- Trigger: when Slice B/C/D add their lifecycle-queue and
  key-rotation-queue dispatches with similar patterns, extract to
  `@cortex/cloud-tasks-client` package.
- Abstraction lets us swap Cloud Tasks for an alternative queue
  (Cloud Pub/Sub, RabbitMQ, etc.) without touching workflow code.

### 10.4. Per-record / per-data-class legal hold `[Slice C+1]`

- Slice C migration 0011 ships per-tenant `legal_hold` table; F02
  Slice A added the boolean `tenant.legal_hold` column.
- Future: extend `legal_hold` table with `record_id` + `data_class`
  columns to support granular holds (e.g., "hold these specific 50
  customer records but not the rest").
- Termination workflow extends: query `legal_hold WHERE tenant_id =
$1 AND scope IN ('record', 'data_class') AND released_at IS NULL`
  per data class; refuses partial termination if any record is held.
- Trigger: first compliance use case requesting record-level
  granularity.

### 10.5. Auto Cloud SQL approval `[volume trigger]`

- Enterprise approval gate (`dedicated_db_approved`) is currently
  manual per Q-OPEN-6 (cost-conscious gate at low volume).
- Trigger: when Enterprise tenant volume ≥ ~10/month, automate the
  gate. Replace manual UPDATE with a policy-driven approval
  workflow (cost limits, contract validation, signature-based
  approval workflow).

### 10.6. IC01 vertical-package seed `[P5.2 swap]`

- Per Q-OPEN-4: Slice A's IC01 seed is a stub — `initialConfig` is
  whatever the caller passes (typically empty `{}` for non-Display-Data
  tenants).
- IC01 (P5.2 — Industry Ontology) ships vertical packages.
  Provisioning workflow extends: load vertical package per
  `input.vertical` (e.g., 'retail', 'healthcare', 'manufacturing')
  and seed `tenant_config_version` v=1 with the vertical-default
  config.
- Migration path: tenants provisioned pre-IC01 retain their stub
  config; IC01 ship triggers a one-time backfill (or operator
  scripts to update each tenant's config_version).

### 10.7. W01 admin-invite event consumer `[W01 ship]`

- Per Q-OPEN-5: Slice A emits `TENANT_PROVISIONED` audit event;
  W01 (Tenant Onboarding Wizard) is the intended consumer — reads
  the event, creates the initial admin invite via Auth0.
- F02 does not block on W01 or Auth0 — pure event-sourcing
  pattern. W01 ship subscribes (initially via `audit_event` poll;
  Pub/Sub fan-out per roadmap §4.12 when that ships).

### 10.8. Workspaces `[AC02]`

- Per planning-doc D9: F02 ships at tenant level only; workspaces
  (sub-tenant grouping) defer to AC02.
- Spec deviation 6 (planning doc): F02 spec mentions workspaces
  ("per F02") but the substrate isn't designed; AC02's ABAC model
  is required input for the workspace shape.
- Trigger: AC02 design phase opens.

## Appendix A — Phase 1 → F02 swap paths

**Status:** All three resolvers RESOLVED — F02 Slice A swapped them
to real implementations (sub-phases 5.2 / 5.3 / 5.4). This appendix
documents the swap path for each so future similar swaps follow the
same substrate-now / real-impl-later pattern (per ADR-INFRA-007's
KMS-key precedent).

Absorbed from the standalone `f02-swap-paths-for-slice-c-resolvers.md`
doc (retired 2026-04-27 per planning-doc D11). The cross-references
that used to point at the standalone doc now resolve to this appendix.

### A.1. Why Phase 1 stubs at all

Three reasons (originally documented Slice C; preserved here for
future similar substrate-now decisions):

1. **API surface stability for Slice C consumers.** Slice C ships
   `@cortex/quotas` middleware and `@cortex/compute-placement`
   resolvers. These have downstream consumers (HTTP routing,
   deployment pipelines) that need a stable signature today, not
   "wait for F02." Stub implementations let the API surface ship
   while substrate is built in parallel.
2. **Substrate work is independent of F02.** Slice C's substrate
   (`tenant_quota_usage` RLS, audit chain integrity, framework-
   agnostic middleware) doesn't depend on F02's tenant-lifecycle
   workflows. Shipping it during Slice C avoids serializing
   F01 → F02 → F-series critical path.
3. **Phase 1 → F02 transition is testable + contractual.** Each
   resolver had a regression-guard test asserting the Phase 1
   behavior; F02 added new tests for the swapped behavior; the
   doc you're reading was the contract specifying the swap shape.
   Risk was bounded.

### A.2. Resolver 1 — `getKeyForTenant` `[Slice B → F02 Slice A]`

**Phase 1 contract:**

```typescript
function getKeyForTenant(tenantId: string): string;
```

Returns env's `cortex-general-key` resource name regardless of
`tenantId`. Pure function; no DB query.

**F02 contract (RESOLVED — sub-phase 5.2):**

```typescript
function getKeyForTenant(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
): Promise<string>;
```

- Queries `tenant_kms_key` table for the row matching `tenantId`.
  RLS bind required (caller's responsibility — see §3.5).
- Returns the row's `kms_key_resource_name` field.
- Throws `TenantKmsKeyNotFoundError` (NEW class added in sub-phase
  5.2; in `@cortex/secrets/src/errors.ts`) if no row exists for
  the tenant.
- Throws `SecretsValidationError` if `tenantId` fails UUID validation.
- Preserves operational `[SECRETS-AUDIT]` log emission on success +
  validation-error + not-found paths (per planning-doc SA15).

**Migration steps (executed):**

1. Slice B's `tenants.create` populated `tenant_kms_key` rows at
   provisioning time with the env key. Substrate-now.
2. F02 Slice A swapped the resolver to consult the table (real-impl).
3. `@cortex/encryption/src/encrypt.ts:139` updated to `await getKeyForTenant(db, ...)`.
4. Tests rewritten: `per-tenant-keys.spec.ts` (DB-dependent — seeds tenants,
   asserts on real lookups + not-found behavior). `encrypt.spec.ts`
   updated 14 tests with substrate-seeding helper (`seedTenantKmsKey`).

### A.3. Resolver 2 — `getQuotaConfig` `[Slice C → F02 Slice A]`

**Phase 1 contract:**

```typescript
function getQuotaConfig(tier: QuotaTier, resourceClass: ResourceClass): bigint;
```

Returns `DEFAULT_TIER_QUOTAS[tier][resourceClass]`. Pure function.

**F02 contract (RESOLVED — sub-phase 5.3):**

```typescript
function getQuotaConfig(
  tier: QuotaTier,
  resourceClass: ResourceClass,
  ctx?: { tenantId?: string; db?: NodePgDatabase<Record<string, never>> },
): Promise<bigint>;
```

- If `ctx.tenantId` and `ctx.db` both supplied: query
  `tenant_config_version` (latest version where `tenant_id =
ctx.tenantId`); read `config_json.quotas[resourceClass]`; if
  present, coerce to bigint (jsonb returns number) and return.
- If `ctx` is omitted, or only one of `tenantId` / `db` is supplied:
  fall back to `DEFAULT_TIER_QUOTAS[tier][resourceClass]` (Phase 1
  behavior preserved for legacy callers).
- If `config_json.quotas[resourceClass]` is absent (partial
  override): falls back to defaults.

**Migration steps (executed):**

1. F02 Slice A swapped the resolver to be async + consult
   `tenant_config_version` when ctx supplied.
2. `@cortex/quotas/src/middleware.ts:213` updated:
   `override ?? (await getQuotaConfig(tier, resourceClass, {tenantId, db}))`.
   The middleware's `check()` callback already received `tenantId`
   and `db` per request — passing ctx for per-tenant override
   consultation was a one-line change.
3. `config.spec.ts` rewritten with 6 new tests covering the
   per-tenant override path (DB-dependent) plus the existing
   per-tier fallback tests (DB-independent). 11 tests total.
4. `middleware.spec.ts` mock-db helper (`noOverrideDb`) added
   so the middleware tests' empty-db stubs still drive the
   fallback path cleanly.

### A.4. Resolver 3 — `getComputePlacement` `[Slice C → F02 Slice A]`

**Phase 1 contract:**

```typescript
function getComputePlacement(params: GetComputePlacementParams): Promise<ComputePlacement>;
```

Always returns `kind: 'shared'`. Validates params via Zod.

**F02 contract (RESOLVED — sub-phase 5.4):**

```typescript
function getComputePlacement(
  params: GetComputePlacementParams,
  db: NodePgDatabase<Record<string, never>>,
): Promise<ComputePlacement>;
```

- Validates params (unchanged).
- Queries `tenant.tier`: `SELECT tier FROM tenant WHERE id = $tenantId`.
  No RLS bind needed (`tenant` is control-plane, no RLS).
- If `tier === 'ENTERPRISE'`: returns
  `{kind: 'dedicated', cloudRunService: '${workload}-tenant-${tenantId}', placementLabel: 'dedicated', tenantId}`.
- If `tier === 'STANDARD'`: returns shared placement (same as Phase 1).
- If tenant row not found: throws `ComputePlacementConfigError`
  (the existing class — its JSDoc was already written for this
  exact case).

**`db` is a separate argument**, NOT inside `params` (per planning-doc
sub-phase 5.4 lock — Drizzle DB instances aren't trivially zod-
validatable; separating keeps the params zod schema clean).

**Migration steps (executed):**

1. F02 Slice A swapped the resolver to query `tenant.tier`. Function
   was already async; only the body + signature changed.
2. Zero production callers (per pre-flight audit) — only test-only
   ripple.
3. `get-placement.spec.ts` rewritten with mock-db helper
   (`mockDb`/`standardDb`/`enterpriseDb`/`emptyDb`) and 17 tests
   covering both tier branches + error paths + round-trip with
   `parseCloudRunServiceName`.

### A.5. Cross-cutting design decisions (preserved)

#### A.5.1. Why `tenant_config_version` for quotas, not `tenant.tier`?

Quotas are tunable per-tenant (planning-doc Decision 7's "TUNABLE
baseline" framing). A specific tenant on STANDARD tier may need
higher `api_calls_per_minute` than the default — that override lives
in `tenant_config_version` where it can be versioned and audited,
not on the `tenant` row where it'd conflict with the commercial
tier label.

#### A.5.2. Why `tenant.tier` for compute placement, not `tenant_config_version`?

Compute placement IS the commercial tier discriminator — STANDARD
→ shared, ENTERPRISE → dedicated. Putting it in
`tenant_config_version` would let a STANDARD-tier tenant be placed
dedicated, which is a billing/contractual discrepancy.
`tenant.tier` is the single source of truth for the commercial
tier; placement follows.

### A.6. References

- **ADR-INFRA-007** — substrate-now / real-impl-later pattern
  (Slice B precedent for KMS keys).
- **ADR-COMPUTE-001** — Cloud Run vs K8s + service-name format.
- **ADR-LIFECYCLE-001** — F02 state machine + Cloud Tasks
  orchestration (this convention doc's parent).
- **`docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`**
  — Decision 7 (per-tier defaults), Decision 8 (BigInt), Decision 9
  (audit on 429).
- **`docs/planning/f02-tenant-lifecycle-scope.md`** — D7 (migration
  0010 substrate), Q-OPEN-6 (Enterprise approval gate), sub-phases
  5.2 / 5.3 / 5.4 (the swap implementations).
- Implementation files:
  - `packages/secrets/src/per-tenant-keys.ts` — `getKeyForTenant`.
  - `packages/quotas/src/config.ts` — `getQuotaConfig`.
  - `packages/compute-placement/src/get-placement.ts` —
    `getComputePlacement`.

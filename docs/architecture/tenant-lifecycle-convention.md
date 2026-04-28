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
| **AC01** (Agent Control 01, P2.1) | Subscribes when shipped | Revoke active sessions for the suspended tenant. WorkOS session-revoke RPC keyed on `tenant_id`. |
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

**Slice C placeholder.** Workflow shapes — pinned context:

### 6.1. Offboarding

- `tenants.offboard(db, tenantId, ctx)` flips `status` ACTIVE/SUSPENDED
  → OFFBOARDING. Sets `tenant.offboarding_grace_until` to
  `now() + grace_period` (default 30 days; configurable per Q-OPEN-3
  - spec §3).
- Generates a signed-URL data-export archive. Archive contents:
  full tenant data dump (TBD format — JSON Lines, Parquet, or
  vendor-specific; planning at Slice C).
- Pre-signed URL TTL: 30 days (per spec §3).
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
  actor). `after_state` includes `grace_until` timestamp.
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
  4. Shared-DB cascade, single transaction: - Emit `TENANT_TERMINATED` audit event BEFORE the deletes — RLS
     write policy requires `app.tenant_id` bound to an extant tenant
     row; the soft-retain UPDATE comes after so the audit's
     `before_state` snapshot captures `tier`, `external_id`,
     `display_name`, `kms_key_resource_name`, and the
     `offboarding_grace_until` timestamp. - Hard-delete children: `legal_hold` (active + released — full
     wipe per spec §3 "deletes every tenant-scoped trace"; the audit
     chain is the historical record), `tenant_kms_key`,
     `tenant_config_version`, `tenant_quota_usage`. Order is
     arbitrary — none of these tables FK each other; all FK to
     `tenant` (which we soft-retain). - Soft-retain the `tenant` row: `UPDATE tenant SET status='TERMINATED',
terminated_at=msNow, updated_at=msNow`. The tombstone keeps
     `audit_event.tenant_id` references valid for forensic queries.
     `tenants.get` / `tenants.getByExternalId` filter `status='TERMINATED'`
     at the application layer and surface `TenantNotFoundError` —
     indistinguishable from hard delete at the API surface, satisfying
     spec §3's "post-termination queries return tenant-not-found".
     `tenants.list` is intentionally unfiltered so operators can review
     tombstones for compliance.
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
  the event, creates the initial admin invite via WorkOS.
- F02 does not block on W01 or WorkOS — pure event-sourcing
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

# Quotas + Compute Placement Convention

Pattern reference for any module emitting quota checks via
`@cortex/quotas` or resolving compute placement via
`@cortex/compute-placement`. Read before writing rate-limiting
middleware, quota-counting service code, or Cloud Run-deployment
pipelines in a new module.

Companion documents: ADR-COMPUTE-001 (Cloud Run vs K8s),
ADR-INFRA-007 (substrate-now / real-impl-later precedent),
ADR-AU-001 (audit emission),
`docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`,
`docs/architecture/f02-swap-paths-for-slice-c-resolvers.md`.

## 1. Scope

`@cortex/quotas` covers:

- Token bucket per `(tenant, resource_class)` backed by
  `tenant_quota_usage` (Slice A migration 0007).
- Audit emission of `QUOTA_EXCEEDED` events on every 429.
- HTTP middleware: framework-agnostic core + Hono / Express
  structural adapters.
- Per-tier defaults via `getQuotaConfig(tier, resourceClass)`.

`@cortex/compute-placement` covers:

- `getComputePlacement(params)` resolver — Phase 1 stub returning
  shared placement; F02 swaps to read `tenant.tier`.
- `parseCloudRunServiceName(name)` round-trip validation for
  deployment pipelines.

Out of scope (deferred):

- Distributed token bucket / Redis-backed quota state — DB-backed
  via `tenant_quota_usage` is the chosen path (planning Decision 5).
- True concurrent-connection limiting — belongs at the
  connection-pool layer (PgBouncer/PgCat); see §9.
- Real ENTERPRISE Cloud Run provisioning — F02 territory.
- AC01 actor resolution — Phase 1 audit emissions are
  service-attributed (`actorId='cortex-quotas'`).
- Per-tenant quota config in `tenant_config_version` — F02 swap
  path documented in `f02-swap-paths-for-slice-c-resolvers.md`.

## 2. The return-not-throw rule (HIGHEST PRIORITY)

**`@cortex/quotas` does NOT throw on quota exceedance.** `checkQuota`
returns a discriminated `CheckQuotaResult`:
`{ allowed: true } | { allowed: false }`. The library throws ONLY for
validation failures, config errors, or DB execution failures (RLS
denial, driver error). Quota exceedance is the canonical "request
must be 429'd" signal — it's not a failure in the developer sense.

**Why this matters:** throwing inside a caller's transaction would
cause drizzle's `db.transaction` wrapper to roll back the audit row +
the upsert that just happened. Per planning Decision 9, every 429
MUST emit its own audit event; that requires the audit to commit,
which requires no throw.

`QuotaExceededError` class still exists in `errors.ts` but is
constructed by callers, not thrown by the library. Callers wanting
throw-semantics (worker processes bubbling to a retry framework)
construct it manually from the result:

```ts
const result = await checkQuota(db, params, opts);
if (!result.allowed) {
  throw new QuotaExceededError('over limit', {
    currentValue: result.currentValue,
    quotaLimit: result.quotaLimit,
    retryAfterSeconds: result.retryAfterSeconds,
  });
}
```

The HTTP middleware (sub-phase 4) consumes the discriminated result
directly without any throw round-trip.

This rule is COUNTER-INTUITIVE relative to Slice B's
`@cortex/encryption` (which throws on cross-tenant decrypt). The
divergence is load-bearing — preserve it.

## 3. REJECT verb semantic expansion

Per ADR-AU-001 Decision 3, the `REJECT` verb covers BOTH
workflow-rejections AND throughput-rejections:

- **Workflow:** approval flow rejected, deployment rejected,
  permission grant denied, etc. Future `*_REJECTED` action names
  from F02-onward modules.
- **Throughput:** quota exceeded, rate limit hit, circuit breaker
  open. `QUOTA_EXCEEDED` is the canonical Slice C example.

Audit consumers querying for `REJECT`-verb events MUST filter by
action name to disambiguate. Don't infer "throughput rejection" from
verb alone — the workflow rejections are equally valid and
operationally distinct.

## 4. Strict-greater "exceeded" semantic

Token bucket comparison uses `>` (strict greater than), not `>=`.

- The 600th request in a 600-cap window **passes**.
- The 601st request **rejects** with 429.

This matches industry convention — Stripe, AWS, Cloudflare all
document rate limits as "up to N requests" (inclusive). If you
change to `>=`, the at-limit-boundary test in
`check-quota.spec.ts` will fail; that's the regression guard.

## 5. BigInt at API boundaries

All quota arithmetic is `bigint`-native (planning Decision 8). The
boundary rules in one place:

- **`pg`'s default driver returns `bigint` as STRING** (not
  `BigInt`) for raw `db.execute()`. Drizzle's `bigint` mode applies
  to schema-typed queries (`db.select().from(table)`), NOT raw SQL
  paths. Explicit `BigInt(row.field)` coercion at the boundary.
- **`JSON.stringify` does NOT serialize `bigint`** — throws
  `TypeError: Do not know how to serialize a BigInt`. Use
  `String(value)` before any JSON serialization.
- **Pino's default serializer also chokes on `bigint`.** Same
  rule; `String(value)` for log fields.
- **HTTP response bodies (429 with quota details):**
  `String(currentValue)`, `String(quotaLimit)` at the response
  boundary. The middleware adapters (Hono + Express) do this.
- **Audit payload `after_state`:** `String()` conversion before
  passing to `emitAuditEvent`. The `check-quota.ts` rejection path
  does this for `current_value` / `quota_limit` / `increment`.
- **HTTP `Retry-After` header:** `number` (seconds), not `bigint`.
  The cast is always safe — windows are bounded; retry seconds
  always fit `Number.MAX_SAFE_INTEGER`.

## 6. `sql.raw` + allow-list pattern

Postgres function-name-needs-literal cases (e.g.,
`date_trunc('minute', ...)`) can't be parameterized via the standard
`${}` interpolation in drizzle's `sql` template. `sql.raw` bypasses
parameterization but creates SQL injection risk if input drifts.

**Defense:** allow-list check before `sql.raw`:

```ts
const VALID_ALIGNMENTS: ReadonlySet<WindowAlignment> = new Set(['minute', 'hour']);

if (!VALID_ALIGNMENTS.has(window.alignment)) {
  throw new QuotaConfigError(`Unknown window alignment '${window.alignment}'`);
}
const alignmentSql = sql.raw(`'${window.alignment}'`);
```

The pattern: validate against a static allow-list FIRST; `sql.raw`
NEVER interpolates user-supplied or untrusted input. If a future
contributor adds a new alignment value, the allow-list catches it
before the SQL is issued.

## 7. Atomic upsert via `INSERT ... ON CONFLICT DO UPDATE`

Token bucket increment uses a single SQL statement (full form in
`check-quota.ts`). Three load-bearing details:

- `UNIQUE (tenant_id, resource_class, window_start)` enables
  `ON CONFLICT`. Postgres takes a row-level lock on the conflicting
  row before applying the UPDATE; concurrent INSERTs serialize
  correctly (verified by the 10-parallel-call atomicity test).
- `date_trunc(alignment, clock_timestamp() AT TIME ZONE 'UTC') AT
TIME ZONE 'UTC'` for window boundary — the UTC round-trip ensures
  cross-region determinism regardless of cluster timezone.
- `clock_timestamp()` not `now()`. `now()` returns transaction-start
  time (constant within a transaction); a long transaction would
  bucket all its requests into the start-time window.

## 8. Pre-check vs post-emit pattern (`resolveIncrement`)

Two invocation patterns depending on whether consumption is known
before or after the request:

```ts
// Pattern A — pre-check (api_calls_per_minute, db_connections):
// middleware fires resolveIncrement before the request runs.
const middleware = honoQuotaMiddleware({
  resolveResourceClass: () => 'api_calls_per_minute',
  resolveIncrement: () => 1n,
  /* ...other resolvers */
});

// Pattern B — post-emit (cpu_seconds, ram_mb): call checkQuota
// directly AFTER work completes with measured increment.
const result = await doWork();
const elapsedSeconds = Math.ceil((Date.now() - startTime) / 1000);
await checkQuota(
  db,
  { tenantId, resourceClass: 'cpu_seconds', increment: BigInt(elapsedSeconds) },
  { tier },
);
```

Pattern B doesn't short-circuit the request (work already ran). If
the post-work counter is over limit, the audit row records it and
subsequent requests 429.

## 9. `db_connections` semantic simplification

`db_connections` counts **connections opened per minute** (NOT
concurrent connections held). True concurrent-connection limiting
belongs at the connection-pool layer (PgBouncer / PgCat /
equivalent), not in application-layer quotas.

A tenant opening 1,000 connections per minute is operationally
meaningful (correlates with concurrent count for healthy services
that release promptly). A point-in-time concurrent gauge would
require an acquire/release API pair (increment on acquire, decrement
on release, leak detection on release-failure paths) that's
significantly larger surface than Slice C's scope.

If first-consumer load profile reveals a true concurrent-limiting
need, F02 ships a separate primitive (NOT a redefinition of this
one) per ADR-COMPUTE-001's "purely additive migration" pattern.

## 10. Cloud Run service-name conventions

Per ADR-COMPUTE-001 §1, §2, §4:

- **63-char service-name limit** (Cloud Run hard limit).
- **Format:** `{workload}-shared` (STANDARD) or
  `{workload}-tenant-{uuid}` (ENTERPRISE).
- **Workload max 19 chars** — workload + `-tenant-` (8) + 36-char
  UUID = 63 exactly at the limit. `cortexWorkloadSchema` enforces
  uniformly across both placement shapes.
- **`env` namespace via the GCP project** (`projects/sevyn8-cortex-{env}/...`),
  NOT in the service name. Embedding env in the name would consume
  budget needed for the UUID under dedicated.
- **`placement` label** (`shared`/`dedicated`) is **deployment
  shape**, NOT commercial tier.
- **`tenant.tier` column** (`STANDARD`/`ENTERPRISE`) is the
  **commercial tier**, lives in the DB.
- **`parseCloudRunServiceName`** validates format at deployment
  time; round-trips `getComputePlacement` output.

## 11. Tunable defaults (`DEFAULT_TIER_QUOTAS`)

Per planning Decision 7, the per-tier defaults are STARTING
BASELINES, not load-derived truths. Callers seeing 429s on
legitimate traffic adjust via the F02 `tenant_config_version`
override path, NOT by widening the hardcoded defaults — overrides
are versioned + auditable, while widening a constant is invisible
in the audit trail.

> Defaults exist as a floor, not a target.

## 12. Hybrid DI conventions

Same shape as `@cortex/encryption` and `@cortex/audit-events`:

- `createQuotaChecker(opts?)` factory — for tests / consumers
  wanting explicit construction.
- Module-scope `defaultChecker` backing the convenience exports.
- `checkQuota(db, params, opts)` — the canonical caller surface.
- `__setCheckerForTesting(checker)` / `__resetForTesting()` — test
  escape hatches, prefixed with `__` per workspace convention.

The `vi.mock`-safe split — `catalog.ts` separate from `check-quota.ts`
— mirrors the `@cortex/encryption` / `@cortex/tenant-context`
precedent. Top-level `registerAuditActions(...)` calls live in
`catalog.ts` (a side-effect-free re-export module); test files
mocking `check-quota.js` via `vi.mock(...)` don't trip the
registration race.

## 13. Composition order for HTTP middleware

```
observability → tenant-context → quotas → handler
```

ORDER IS MANDATORY:

- **observability OUTERMOST:** any logs emitted downstream carry
  `correlation_id`, `trace_id`, `span_id`.
- **tenant-context BEFORE quotas:** `bindTenantToDbSession` MUST
  have run; both the `tenant_quota_usage` upsert AND the
  `QUOTA_EXCEEDED` audit emission require RLS to be satisfied.
- **quotas BEFORE handler:** 429s short-circuit; the handler
  doesn't run on rejection.

Convention: HTTP middleware that emits audit events MUST run after
tenant-context. Future middleware authors who add a new audit-
emitting layer should compose AFTER tenant-context, not before.

## 14. Cross-tenant smuggling — highest-priority correctness concern

Per ADR-COMPUTE-001 §3 negative consequences. STANDARD tier relies
on application-layer isolation via 4 mechanisms — RLS on every
tenant-scoped table (Slice A), AAD encryption with tenant-id
binding (Slice B), async-local context propagation (Slice A),
quota enforcement per-tenant (Slice C). F02 ENTERPRISE adds
process-level isolation as a 5th.

A bug in any single layer is a multi-tenant data leak. Defense in
depth is the design. **Never trust a single isolation layer** —
new code touching per-tenant data should be reviewable in terms of
which mechanisms protect each read/write; at least 2 of 4 should
apply, ideally 3+.

## 15. Common pitfalls

Recurring traps Slice C surfaced; check against this list when
shipping new code in this area:

1. **Forgetting `bindTenantToDbSession` before `checkQuota`** — RLS
   denies the upsert (42501); surfaces as `QuotaExecutionError` with
   `cause.code='42501'`.
2. **Using `>=` instead of `>` for exceeded comparison** — rejects
   the at-limit request; breaks the boundary test (§4).
3. **Throwing `QuotaExceededError` from inside library code** —
   rolls back the audit row that just emitted (§2).
4. **`BigInt → JSON.stringify` without `String()`** — throws
   `TypeError`. Convert at the response / log boundary (§5).
5. **`sql.raw` without an allow-list check** — SQL-injection risk;
   gate with `Set.has(input)` before interpolating (§6).
6. **Cloud Run service-name issues** — name >63 chars, `env` in
   service name, workload >19 chars under dedicated. Validate via
   `parseCloudRunServiceName` in CI (§10).
7. **`async function` with no `await`** — ESLint flags
   `@typescript-eslint/require-await`. Use `function` returning
   `Promise.resolve(...)`.
8. **`placeholder.spec.ts` left in `test/` after real specs land** —
   delete it (precedent: encryption sub-phase 6, quotas sub-phase 5).
9. **Hardcoded actor `'cortex-quotas'`** — Phase 1 limitation;
   AC01 will add a request-scoped actor resolver. Don't add new
   hardcoded actors without flagging the AC01 swap path.

## 16. References

- `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md` — slice scope, 9 decisions
- ADR-COMPUTE-001 — Cloud Run vs K8s + service-name format
- ADR-INFRA-007 — substrate-now / real-impl-later precedent (Slice B / KMS)
- ADR-AU-001 — audit-events library; REJECT verb scope
- ADR-DB-002 — RLS posture (`tenant_quota_usage` already FOR ALL with WITH CHECK from Slice A)
- `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md` — F02 evolution contracts
- `docs/architecture/encryption-blob-storage-convention.md` — Slice B precedent for this doc's structure
- Migration `services/foundation/migrations/0007_control_plane_tables.sql` — substrate
- `packages/quotas/src/`, `packages/compute-placement/src/` — implementations

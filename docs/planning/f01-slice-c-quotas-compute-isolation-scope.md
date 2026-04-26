# F01 Slice C: Quotas + Compute Isolation — Scope

**Status:** Scoping complete, implementation queued
**Scoped:** 2026-04-26
**Primary sources:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.1 (lines 933–996), Cortex v2.2 Spec §F01-FR-006, F01 §3 (compute isolation), F01 §6 (resource quotas)
**Companion ADR:** ADR-COMPUTE-001 (Cloud Run vs K8s compute isolation)

---

## Context

F01 P1.1 closes with this slice. Slice A (commit `4811821`) shipped tenant
context + DB isolation. Slice B (commit `c64192f`) shipped encryption +
blob isolation. Slice C ships the two remaining F01 §1 line items:
**compute isolation (§3)** and **resource quotas (§6)**.

Slice A's substrate is already in place: `tenant_quota_usage` table from
migration 0007 ships with the correct RLS posture (FOR ALL with
WITH CHECK; no Slice-B-style fix migration needed) plus `UNIQUE
(tenant_id, resource_class, window_start)` for atomic upsert via
`ON CONFLICT DO UPDATE`. The `tenant.tier` column was also shipped Slice
A (NOT NULL CHECK on `('STANDARD', 'ENTERPRISE')`); Slice C is its first
conditional consumer.

Slice B established conventions Slice C inherits: hybrid DI (factory +
module-scope default + `__set*ForTesting` escapes); dynamic-import cycle
break for `@cortex/observability`; catalog file split for vi.mock-safe
`registerAuditActions`; hardcoded service actor pending AC01 (roadmap
§4.14). Slice C respects all four.

Three pre-existing constraints shape the Slice C surface:

- **Cloud Run, not K8s.** F01 build prompt §3 specifies "Kubernetes
  namespace per Enterprise tenant"; Cortex platform is Cloud Run per
  ADR-INFRA-006 (WIF auth-target identity layer) + ADR-INFRA-003
  (VPC topology). Roadmap §9.7 anticipated this deviation since Slice A;
  ADR-COMPUTE-001 (companion) records the formal resolution.
- **No live HTTP consumer.** No service has `package.json` outside
  `services/foundation`; no Cloud Run service is provisioned. Slice C's
  middleware is forward-defined: ready-to-compose when the first
  F-series service ships HTTP. Mirrors `@cortex/tenant-context`'s
  framework-agnostic pattern (Hono + Express adapters, structural
  duck-typed interfaces, no runtime framework dep).
- **Phase 1 reality is one tenant.** Display Data is the only tenant.
  Per-tenant quota config in `tenant_config_version` is F02 territory;
  Slice C ships hardcoded per-tier defaults that F02 promotes to
  configurable values without breaking Slice C's API surface.

## In scope

### Library: `/packages/quotas`

`@cortex/quotas` package — token-bucket quota enforcement against the
`tenant_quota_usage` substrate. Public API:

- `checkQuota(db, params)` — atomic upsert + check. Increments
  `current_value` for `(tenantId, resourceClass, current window)` via
  `INSERT … ON CONFLICT DO UPDATE`; returns `{ allowed: boolean,
remaining: bigint, limit: bigint, retryAfterSeconds: number | null }`.
  Caller decides what to do with the result (HTTP middleware translates
  to 429; service-level callers may have other policies).
- `getQuotaConfig(tier, resourceClass): QuotaConfig` — returns the
  hardcoded per-tier defaults (Decision 7). F02 swaps to read
  `tenant_config_version.config_json.quotas[resource_class]` with
  fallback to these defaults.
- `buildQuotaMiddleware(opts?)` — framework-agnostic HTTP middleware
  that runs `checkQuota` against `api_calls_per_minute`; emits 429 with
  `Retry-After` header on exceedance; emits `QUOTA_EXCEEDED` audit
  event per Decision 9. Hono + Express structural adapters mirroring
  `buildTenantContextMiddleware`.
- Hybrid DI: `createQuotaService(opts)` factory + module-scope default
  - `__setQuotaServiceForTesting` / `__resetForTesting` escapes.
- Module-load cycle break: type-only `Logger` import + dynamic
  `await import('@cortex/observability')` per the §4.13 pattern from
  Slice B's `emit.ts`.

### Library: `/packages/compute-placement`

`@cortex/compute-placement` package — stub resolver returning compute
placement for a tenant. Public API:

- `getComputePlacement(tenantId, db): ComputePlacement` — returns
  `{ kind: 'shared' | 'dedicated', cloudRunService: string }`. Phase 1:
  always returns `kind: 'shared'`, `cloudRunService:
'cortex-{workload}-{env}'`. F02 swaps to consult `tenant.tier` and
  return `kind: 'dedicated'` with the per-tenant service name when the
  first ENTERPRISE tenant onboards.
- `parseCloudRunServiceName(name)` — inverse for forensics; extracts
  `{ workload, env, tenantId? }` from a service-name string.
- Pure helpers; no audit emission, no DB writes (read-only). Smaller
  surface than `@cortex/quotas`.

### Substrate: NONE NEEDED

Migration 0007 already ships `tenant_quota_usage` with the right shape +
RLS. Distinct from Slice B which had to ship 0009 to fix
`tenant_kms_key`. No Slice C migration.

### ADR-COMPUTE-001

Companion ADR (new ADR series — `COMPUTE` for future compute placement
decisions). Records the K8s → Cloud Run deviation per F01 §3; locks the
shared-vs-dedicated tier model; defines the F02 swap path. Resolves
roadmap §9.7.

## Deferred (explicitly out of scope)

Each entry below stays as (or becomes) a roadmap entry in sub-phase 9.

- **Real Cloud Run service-per-tenant deployment.** Lands when first
  ENTERPRISE tenant ships. F02 lifecycle owns provisioning /
  decommissioning; `@cortex/compute-placement.getComputePlacement` is
  the surface F02 fills. Roadmap §9.7 (resolved at the design level by
  ADR-COMPUTE-001; provisioning automation deferred).
- **Per-tenant quota config in `tenant_config_version`.** F02
  territory. Decision 7 documents the swap: `@cortex/quotas` reads from
  `tenant_config_version.config_json.quotas[resource_class]` with
  fallback to Slice C's hardcoded defaults. Slice C ships the fallback
  layer; F02 ships the override layer.
- **Distributed token bucket / Redis.** DB-backed via
  `tenant_quota_usage` UPDATEs is the chosen path per Slice B planning
  Decision 5. Memorystore Redis would be revisited if observed write
  latency on `tenant_quota_usage` exceeds the quota-check budget
  (~5ms target). Roadmap §10.5 resolved by Slice C; revisit as a new
  entry if the latency budget is missed.
- **Cross-region quota aggregation.** Single-region asia-south1 by
  default per ADR-INFRA-003. Multi-region is Phase 2+ DR territory.
- **Quota burst policies (refill rate, burst capacity beyond window).**
  Slice C contract is a windowed counter — `current_value` ratchets up
  within a 1-minute window; new window resets to zero. Burst-bucket
  semantics (sustained rate + temporary burst capacity) are a Phase 2+
  refinement.
- **Apigee / API Gateway integration.** Roadmap §10.5 future option C
  — rejected. Application-layer token bucket via `@cortex/quotas` is
  the chosen path.
- **Cloud Run revision-level concurrency / CPU / RAM caps.** Per-tenant
  Cloud Run service resource limits (under ENTERPRISE tier) are
  configured at Terraform deploy time; Slice C's `getComputePlacement`
  returns the service name, not the resource budget. F02 + Terraform
  module own the resource-cap layer.
- **gRPC / Pub/Sub quota propagation.** F01 build prompt §1 mentions
  "every outbound call propagates tenant_id via headers / metadata".
  Slice A shipped HTTP middleware; gRPC + Pub/Sub propagation lands
  with first F-series consumer that needs it.

## Decisions

### Decision 1 — Separate package `@cortex/quotas`

**Decision.** New workspace package `@cortex/quotas`, not a submodule of
`@cortex/tenant-context` or `@cortex/observability`. Token-bucket logic,
audit emission, and middleware live in one package; consumers import
either the middleware factory (HTTP integration) or the lower-level
`checkQuota` (service-level use cases).

**Reasoning.** Mirrors Slice B's two-package decision (`@cortex/encryption`

- `@cortex/blob-storage`). Quota enforcement is a distinct concern from
  tenant binding (tenant-context owns that) and from observability
  (metrics emission is a side effect, not the surface). A combined
  `@cortex/tenant-context` package would force every tenant-context
  consumer to accept the quotas dep + DB write surface.

**Alternatives considered.** Inline into `@cortex/tenant-context`
(rejected — couples concerns); `@cortex/foundation` umbrella package
(rejected — Cortex doesn't have an umbrella; each F-series concern is a
package).

### Decision 2 — Forward-defined middleware (framework-agnostic + Hono/Express adapters)

**Decision.** `buildQuotaMiddleware()` returns `{ hono(c, next),
express(req, res, next) }` adapter methods. Structural duck-typed
interfaces matching `@cortex/tenant-context.buildTenantContextMiddleware`
and `@cortex/observability.buildHttpMiddleware`. No runtime framework
dep.

**Reasoning.** F01 build prompt §1 specifies "Middleware for HTTP
(Fastify plugin)..." but Slice A picked Hono + Express adapters
(roadmap §10.11 still Open). Slice C does NOT force the framework
choice — composes into whichever pattern the first F-service picks.
Composition order: observability → tenant-context → quotas → handler.

**Alternatives considered.** Commit to Hono now (rejected — premature;
roadmap §10.11 calls for first F-service to drive the choice); ship a
pure `checkQuota` and let consumers wire their own middleware
(rejected — reinvents middleware per F-service, drift risk).

### Decision 3 — Separate package `@cortex/compute-placement`

**Decision.** Compute placement (the `getComputePlacement(tenantId)`
resolver + ComputePlacement type) lives in its own package, not in
`@cortex/tenant-context` or `@cortex/quotas`.

**Reasoning.** Compute placement is a deployment-shape concern, not a
quota concern; conflating them would lock quotas to compute decisions
that Phase 2+ will revisit. Per-tenant compute placement is also
F02-owned (the lifecycle automation); Slice C ships the API surface F02
fills. Sibling package keeps the boundary clean.

**Alternatives considered.** Submodule of `@cortex/quotas` (rejected —
different concern); inline into `@cortex/tenant-context` (rejected —
tenant-context already heavy with audit + DB binding + middleware).

### Decision 4 — ADR-COMPUTE-001 (new ADR series)

**Decision.** Compute placement decisions get their own ADR series
(`COMPUTE`). ADR-COMPUTE-001 records the K8s → Cloud Run deviation;
future compute decisions (Cloud Run revision pinning, multi-region
placement, edge compute for ED01) extend this series.

**Reasoning.** Existing ADR series cover infrastructure (`INFRA-*`),
database (`DB-*`), observability (`OBS-*`), audit (`AU-*`), MCP
(`MCP-*`), CI (`CI-*`), sequencing (`SEQ-*`), scope (`SCOPE-*`).
Compute is a distinct concern crossing all of these; a dedicated series
keeps the cross-references clean. F01 §3 is the trigger; ADR-COMPUTE-001
is the canonical record.

**Alternatives considered.** Extend `INFRA-*` (rejected — INFRA is
GCP-resource-shape territory; compute placement is a runtime decision);
extend `SCOPE-*` (rejected — SCOPE is product-shape, not platform).

### Decision 5 — Full Slice C implementation today

**Decision.** All 10 sub-phases ship in one session, with HOLD-for-review
checkpoints between each. Single squash commit at sub-phase 10. Total
estimated 14–17 hours.

**Reasoning.** Mirrors Slice B's cadence (10 sub-phases, ~16 hours
actual). Single-session shipping avoids context re-paging cost.
HOLD-for-review keeps approval per sub-phase.

### Decision 6 — 4 resource classes (full F01 §6 spec)

**Decision.** Slice C ships token bucket for all 4 resource classes
specified in F01 §6:

- `api_calls_per_minute` — request count per tenant per minute (HTTP
  middleware integration)
- `db_connections` — concurrent DB connections per tenant (consumed by
  service-level callers acquiring connections)
- `cpu_seconds` — accumulated CPU-seconds per tenant per window
  (consumed by long-running services tracking CPU usage)
- `ram_mb` — accumulated RAM-MB-seconds per tenant per window (same
  shape as cpu_seconds)

Per-tier defaults (Decision 7) are tuned for STANDARD vs ENTERPRISE.
Window for `api_calls_per_minute` is 1 minute (`date_trunc('minute',
now())`); window for the other three is 1 hour (`date_trunc('hour',
now())`) to match typical billing-window granularity.

**Reasoning.** F01 §6 lists all 4 explicitly. Shipping one and
deferring the others would force a follow-up sub-phase — not worth the
sequencing complexity. The schema (`tenant_quota_usage.resource_class`
is free-form text) supports adding new resource classes later without
migration.

**Alternatives considered.** Ship only `api_calls_per_minute` (the
HTTP-middleware-integrated one) and defer the rest (rejected — F01 §6
lists all four; F-series consumers will hit them in scattered order, so
land them all together to avoid re-coordination cost).

**All four resource classes are windowed counters; the semantic differs
in what's being counted.** `api_calls_per_minute` counts API request
invocations; `db_connections` counts connection acquisitions per
minute (NOT concurrent connections held); `cpu_seconds` counts compute
time consumed in the window; `ram_mb` counts memory-seconds (or
peak-MB samples). All accumulate via `tenant_quota_usage.current_value`
and reset on window boundary.

The `db_connections` semantic is a deliberate simplification — true
concurrent-connection limiting belongs at the connection-pool layer
(PgBouncer or equivalent), not in application-layer quotas. A tenant
opening 1,000 connections/minute is operationally meaningful
(correlates with concurrent count for healthy services); a
point-in-time gauge would require an acquire/release API pair
(increment on acquire, decrement on release, leak detection on
release-failure paths) that's significantly larger surface than Slice
C's scope. If first-consumer load profile reveals a true
concurrent-limiting need, F02 ships a separate primitive (NOT a
redefinition of this one) per ADR-COMPUTE-001's "purely additive
migration" pattern. Convention doc (sub-phase 8) flags the
simplification for downstream consumers.

### Decision 7 — Hardcoded per-tier defaults; F02 promotes to `tenant_config_version`

**Decision.** `@cortex/quotas` ships hardcoded per-tier defaults in
`src/defaults.ts`:

| Resource class           | STANDARD                  | ENTERPRISE               |
| ------------------------ | ------------------------- | ------------------------ |
| `api_calls_per_minute`   | 600 (10 req/sec)          | 6,000 (100 req/sec)      |
| `db_connections`         | 10                        | 50                       |
| `cpu_seconds` (per hour) | 3,600 (1 vCPU-hour)       | 36,000 (10 vCPU-hours)   |
| `ram_mb` (per hour)      | 1,800,000 (≈500 MB-hours) | 18,000,000 (≈5 GB-hours) |

`getQuotaConfig(tier, resourceClass)` returns these. F02 swap path:
`tenant_config_version.config_json.quotas[resource_class]` overrides
the default; absence falls back to the per-tier default. This means
F02 ships the override layer without breaking Slice C's API surface;
Slice C callers see no change.

**Reasoning.** Phase 1 has one tenant; per-tenant config is overkill.
Hardcoded defaults provide a sane starting baseline; F02 lifecycle
automation can populate `tenant_config_version` rows when configurable
values become operational requirements.

**Tunable baseline.** Per-tier default values are a sane starting
baseline, not a load-derived truth. STANDARD `api_calls_per_minute` =
600 (10 req/sec), ENTERPRISE = 6,000 (100 req/sec); `cpu_seconds` and
`ram_mb` scaled proportionally. These values are NOT based on a real
load profile (Display Data load profile lands with the first F-series
consumer; F02 owns the real-tenant tuning). The convention doc
(sub-phase 8) flags these as TUNABLE: any caller seeing 429s in
legitimate traffic should adjust via the F02 swap path
(`tenant_config_version.config_json.quotas[resource_class]`), NOT by
widening the hardcoded defaults. Document this prominently to avoid
the "everyone bumps the default when they see 429s" failure mode —
the defaults exist as a floor, not a target.

**Alternatives considered.** Per-tenant config from day one (rejected
— premature; Display Data has no special quota requirements); env-var
configuration (rejected — quotas are tenant-scoped, not env-scoped;
env-var config doesn't compose with multi-tenant); read from
`tenant_config_version` immediately with empty rows (rejected —
double-write at provisioning; F02 owns this).

### Decision 8 — BigInt-native end-to-end

**Decision.** All quota arithmetic uses JS `BigInt`. `current_value`
and `quota_limit` columns are `bigint` in Postgres; Drizzle's `bigint`
mode returns `BigInt` (not `number`). Slice C does NOT convert at the
DB boundary; arithmetic stays `BigInt`-native. Conversion to `number`
happens only at API boundaries that require it: HTTP response headers
(`Retry-After`), structured log fields (pino doesn't serialize `BigInt`
cleanly without a custom serializer).

**Reasoning.** Quota limits could exceed `Number.MAX_SAFE_INTEGER` (2^53)
for high-volume tenants on long windows. `cpu_seconds` per hour at peak
ENTERPRISE rate × 24 hours × 365 days = ~31M, well under 2^53. But
`ram_mb` summed in micro-second resolution × 1 year would overflow at
multi-tenant scale (>10^16). BigInt-native eliminates the conversion
gotcha entirely; the only `number` conversion site is at boundary
serialization, where bounded-magnitude values are safe.

**Implementation note.** The `bigint` mode in Drizzle's column
definition means TypeScript sees `bigint`, runtime gets `BigInt`. All
arithmetic in `checkQuota` (e.g., `newValue = current_value + 1n`)
uses `BigInt` literals (`1n`, not `1`). Tests assert with `BigInt`
comparisons (`expect(result.remaining).toBe(599n)`).

**Alternatives considered.** `number` everywhere with cast-at-DB
(rejected — silent precision loss above 2^53); `string` representation
end-to-end (rejected — defeats arithmetic; forces parse on every
operation).

**Serialization boundary.** `JSON.stringify` does NOT serialize
`bigint` natively (throws `TypeError: Do not know how to serialize a
BigInt`). Pino's default serializer also chokes on bigint fields.
Sub-phase 4's HTTP middleware MUST convert via `String(currentValue)`
when constructing the 429 error response body; the same pattern
applies to any audit `payload` field carrying a bigint (sub-phase 3's
`QUOTA_EXCEEDED` audit emission converts `current_value` /
`quota_limit` / `increment` to strings before passing to
`emitAuditEvent`). The convention doc (sub-phase 8) enumerates this
gotcha alongside the audit-events / encryption package serialization
notes — a single "BigInt at API boundaries" reference for future
authors.

### Decision 9 — `QUOTA_EXCEEDED` audit on every 429

**Decision.** Every 429 response emits a `QUOTA_EXCEEDED` audit event
into `audit_event` via `emitAuditEvent`. Verb: `REJECT` (the request is
being rejected; per ADR-AU-001 Decision 3, REJECT verb has both
before_state and after_state optional). `after_state` carries
`{ resource_class, current_value, quota_limit, window_start }` for
forensic reconstruction.

**Reasoning.** F01 §6 acceptance criterion: "Tenant quota exceedance
returns 429 within 50ms" — the 429 itself is the user-facing event,
but the compliance forensic trail is the audit row. Auditors need to
see "tenant X was rate-limited Y times during attack window Z" without
parsing pino logs.

**Volume tradeoff.** QUOTA_EXCEEDED on every 429 produces high audit
volume on attack/burst patterns (a sustained DoS could emit thousands
of audit rows per minute per attacked tenant). Mitigated by:

- (a) Compliance audit_event table has the per-tenant SHA chain (per
  ADR-DB-003); chain integrity tooling (post-SCR-22) handles bulk-row
  forensics. Per-tenant partitioning at SCR-22 indexing time keeps
  query performance bounded.
- (b) Prometheus throttle metric (separate from audit) provides the
  operational rate signal — operators look at metric, auditors look at
  audit_event. Two consumers, two channels.
- (c) Audit volume on legitimate 429s reflects real bot/scrape behavior
  the auditors want to see; suppressing it would defeat the compliance
  purpose.

**Alternatives considered.** Sample 429 audits (1 in N) (rejected —
breaks compliance evidence chain); audit only first 429 per tenant per
window (rejected — auditor needs to see attack-rate, not just first
event); skip audit, rely on metric (rejected — metrics aren't tamper-
evident; compliance requires the chained audit).

## Sub-phases

| #   | Title                                                    | Estimate | Deliverable                                                                                                                                                                                                                  | Acceptance                                                                                                     | Dependencies |
| --- | -------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | Planning doc + ADR-COMPUTE-001 + .gitignore              | 1 hr     | This doc + `docs/architecture/decisions/ADR-COMPUTE-001-cloud-run-vs-k8s-compute-isolation.md` + `.gitignore` adds `.claude/`.                                                                                               | Both files lint-clean; cross-references resolve; review approved.                                              | none         |
| 2   | `@cortex/quotas` scaffold + types + errors + schemas     | 1.5 hr   | New package directory; `package.json` + workspace registration; `src/types.ts` (CheckQuotaParams, CheckQuotaResult, QuotaConfig, ResourceClass); `src/errors.ts`; `src/schemas.ts`; `src/index.ts` placeholder.              | `pnpm typecheck` + `pnpm lint` clean for the package; placeholder spec passes.                                 | 1            |
| 3   | Token bucket logic (atomic upsert) + audit emission      | 2.5 hr   | `src/check.ts` — `checkQuota(db, params)` via `INSERT … ON CONFLICT DO UPDATE`; `QUOTA_EXCEEDED` audit emission on 429-shaped result; hybrid-DI factory + module-scope default + test escapes.                               | Round-trip works against p09-repro; atomic increment under concurrent writes; audit row emitted on exceed.     | 2            |
| 4   | Catalog + barrel + per-tier defaults + middleware        | 2 hr     | `src/catalog.ts` (QUOTA_AUDIT_ACTIONS); `src/defaults.ts` (per-tier table from Decision 7); `src/middleware.ts` (framework-agnostic + Hono/Express adapters); `src/index.ts` public barrel.                                  | Public API stable; defaults surface; middleware composes per `@cortex/tenant-context` precedent.               | 3            |
| 5   | Quotas tests (unit + integration against p09-repro)      | 3 hr     | `test/errors.spec.ts`, `test/types.spec.ts`, `test/schemas.spec.ts`, `test/catalog.spec.ts`, `test/defaults.spec.ts`, `test/check.spec.ts` (integration), `test/middleware.spec.ts`. ~45–55 tests.                           | All tests green against p09-repro; concurrent-write atomicity test passes; cross-tenant isolation test passes. | 4            |
| 6   | `@cortex/compute-placement` package — full               | 2 hr     | New package: `package.json`, types + errors + schemas + `src/placement.ts` (the resolver) + `parseCloudRunServiceName` + barrel + tests. ~20–25 tests.                                                                       | `pnpm test` green; resolver returns shared placement for all tenants in Phase 1; type-narrows on tier.         | 1            |
| 7   | `tenant_config_version` consumer note (F02 swap doc)     | 0.5 hr   | Inline JSDoc + small README addition in `@cortex/quotas/src/defaults.ts` documenting the F02 swap path: `tenant_config_version.config_json.quotas[resource_class]` overrides; fallback to defaults.                          | Doc cross-references planning doc Decision 7 + roadmap entry for F02 swap.                                     | 4            |
| 8   | Convention doc + CLAUDE.md update + status.md            | 1 hr     | `docs/architecture/quotas-compute-placement-convention.md` (when to enforce, BigInt boundary, audit volume, middleware composition, compute-placement F02 swap); CLAUDE.md new section; status.md `[x]` Slice C placeholder. | All cross-references valid; conventions reflect what 2–7 actually shipped.                                     | 2–7          |
| 9   | Roadmap updates (resolve §10.5, §9.7, §10.3; note §10.4) | 0.5 hr   | Roadmap §10.5 marked Resolved (Slice C ships DB-backed token bucket); §9.7 marked Resolved by ADR-COMPUTE-001; §10.3 marked Resolved (substrate Slice A + first consumer Slice C); §10.4 unchanged with note.                | Resolution markers consistent with Slice A / Slice B precedent.                                                | 1, 8         |
| 10  | Final aggregate + commit + push + roadmap backfill       | 1 hr     | Full workspace test pass; lint clean; tsc clean; commit (one `feat(F01-Slice-C)` + one `docs(progress)` backfill); push to origin/main; status.md commit-hash backfill.                                                      | CI green-ish per established pattern; PR-equivalent review packet posted in chat.                              | 1–9          |

Total: ~15 hours nominal.

## Risks & mitigations

- **BigInt overflow at extreme values.** BigInt has arbitrary precision;
  the Postgres `bigint` column tops out at 2^63-1 (~9.2 quintillion).
  Mitigation: clamping happens at the `Number()` conversion boundary
  (HTTP response headers, log fields). `Number()` of values above 2^53
  loses precision but doesn't throw; tests verify the clamping behavior
  at boundary values.
- **Token bucket atomicity under concurrent requests.** `INSERT … ON
CONFLICT (tenant_id, resource_class, window_start) DO UPDATE SET
current_value = tenant_quota_usage.current_value + EXCLUDED.current_value`
  is a single SQL statement; Postgres takes a row-level lock on the
  conflicting row before applying the UPDATE. Mitigation: integration
  test (sub-phase 5) fires N parallel requests at one tenant; assert
  final count = N; assert exactly the expected number breach the limit.
- **Window boundary races.** A request arriving at the exact minute
  boundary could be counted in the old or new window depending on
  `date_trunc('minute', now())` evaluation moment. Mitigation:
  tolerable; the next request resets the window cleanly. Documented in
  the convention doc; not a correctness bug, just a sub-second
  bookkeeping quirk.
- **Cycle topology.** `@cortex/quotas` imports `@cortex/audit-events`
  (audit emission) + `@cortex/observability` (logger via dynamic
  import). No package consumed by `@cortex/quotas` is in turn consumed
  by `@cortex/observability` or `@cortex/tenant-context` directly, so
  no new cycle edge. Mitigation: same dynamic-import pattern as Slice
  B's `@cortex/encryption`; convention doc reminds future authors.
- **Compute placement stub diverges from real per-tenant deployment.**
  When F02 ships ENTERPRISE provisioning, the stub's `cloudRunService`
  format MUST match what F02 actually provisions. Mitigation:
  ADR-COMPUTE-001 locks the format (`cortex-{workload}-{env}` for
  shared; `cortex-{workload}-tenant-{tenant_id}-{env}` for dedicated);
  `parseCloudRunServiceName` round-trips both shapes; F02's Terraform
  module must align with the locked format.
- **Audit volume on burst attacks.** Decision 9's volume tradeoff
  paragraph captures this. Mitigation: per-tenant SHA chain absorbs
  the volume; Prometheus metric is the operational rate signal;
  auditors want the chain depth on attack patterns.
- **HTTP framework choice not forced.** `buildQuotaMiddleware` is
  framework-agnostic per Decision 2. First F-service that ships HTTP
  picks the framework; `@cortex/quotas`' adapter shape adjusts then
  (or stays agnostic permanently if the workspace standardizes on
  multiple frameworks). Roadmap §10.11 unchanged.

## References

- **F01 build prompt §3** (compute isolation), **§6** (resource quotas),
  at `docs/build-prompts/cortex_build_prompts_v3.md` lines 933–996
- **ADR-COMPUTE-001** (companion) — Cloud Run vs K8s compute isolation
- **ADR-INFRA-007** — Slice B precedent for "ship substrate now,
  real-impl later" pattern
- **ADR-INFRA-006** — WIF auth-target identity (Cloud Run is the layer)
- **ADR-INFRA-003** — VPC topology (Cloud Run runs inside VPC)
- **ADR-AU-001** — audit-events library (QUOTA_EXCEEDED emits via this)
- **ADR-DB-002** — RLS posture (`tenant_quota_usage` substrate already
  has FOR ALL with WITH CHECK)
- **Cortex v2.2 Spec §F01-FR-006** — quota requirements
- **Roadmap §9.7** — F01 compute isolation: K8s vs Cloud Run (resolved
  by ADR-COMPUTE-001)
- **Roadmap §10.3** — Tenant tier discriminator (substrate-resolved by
  Slice A; first consumer = Slice C; close in sub-phase 9)
- **Roadmap §10.4** — DB client abstraction shape (F02 territory; Slice
  C confirms shape exists, doesn't ship it)
- **Roadmap §10.5** — Quota enforcement implementation (resolved by
  Slice C)
- **Roadmap §10.11** — HTTP framework choice (unchanged; Slice C stays
  agnostic)
- **Migration `services/foundation/migrations/0007_control_plane_tables.sql`** —
  `tenant_quota_usage` substrate (Slice A; ready for Slice C consumption)
- **`docs/planning/f01-slice-b-encryption-blob-isolation-scope.md`** —
  cadence + decision-format precedent
- **NOTE on Slice A planning doc**: there is no Slice A planning doc
  (Slice A predates the planning-doc convention). The cadence
  precedent is P0.10 → Slice B → Slice C.

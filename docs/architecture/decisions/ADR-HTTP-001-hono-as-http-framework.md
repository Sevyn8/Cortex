# ADR-HTTP-001: Hono as the HTTP framework for Cortex

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** Amit (Sevyn8 engineering)
**Context documents:** `docs/spikes/2026-04-28-hono-prod-readiness.md` (the doc-only spike that informed this decision); `docs/build-prompts/cortex_build_prompts_v3.md` §P1.2; `docs/planning/f02-tenant-lifecycle-scope.md` D3 (HTTP framework forcing function); `docs/future-roadmap.md` §10.11 (open forcing function — resolved by this ADR); Cortex v2.2 Spec §F02
**Companion decisions:** ADR-LIFECYCLE-001 (state machine + Cloud Tasks orchestration — supplies the workflows the HTTP API exposes); ADR-OBS-001 (observability baseline — supplies `createLogger` / `createTracer` for HTTP middleware); ADR-INFRA-006 (WIF identity layer — D8 Cloud Run service-to-service IAM authz pattern lives here)

This is the first ADR in the `HTTP-*` series. Future HTTP decisions (route-shape conventions, middleware ordering, OpenAPI generation strategy, per-method authz pattern post-AC01) extend this series and reference back to the 6 conditions locked here.

---

## Context

F02 Slice D ships an HTTP API exposing Cortex's tenant lifecycle workflows (`tenants.{provision, suspend, resume, offboard, terminate, forceTerminate, rotateKeys}` + `legalHolds.{set, release}` — 9 endpoints). The framework choice scopes Slice D's surface plus all subsequent F0X HTTP work: F03 Temporal Data Engine, F04 Configuration Plane, F05 Schema Evolution Engine, and downstream services. Once a framework choice is in production code with middleware patterns, observability wiring, and operator runbooks, switching costs grow nonlinearly.

The 2026-04-28 spike (`docs/spikes/2026-04-28-hono-prod-readiness.md`) investigated Hono across 12 categories — maturity signals, Cloud Run fit, TypeScript fit, OpenTelemetry integration, logging integration, error handling, tenant-context middleware composition, audit emit lifecycle, RLS bind lifecycle, validation, testing, operational concerns. Outcome: **8 green / 4 yellow / 0 red.** Spike recommendation: GO with conditions.

The workspace already structurally commits to Hono at the middleware-adapter layer: `buildTenantContextMiddleware().hono(c, next)` ships in `packages/tenant-context/src/middleware.ts` (per F01 Slice A) with structural test coverage in `packages/tenant-context/test/middleware.spec.ts`. This ADR formalizes that structural commitment as a binding architectural decision and — more importantly — codifies the 4 yellows from the spike as 6 binding conditions on Slice D implementation.

The alternative path — leaving the framework choice as a "spike recommendation" without an ADR — fails: spikes are informational, not binding. D.1 prototype work needs constraints with teeth (e.g., "if cold-start p95 > 500ms, reopen the framework decision"), not preferences ("we should probably check cold-start"). This ADR provides the teeth.

## Decision

**Hono is adopted as the HTTP framework for all Cortex HTTP API surface, beginning with F02 Slice D.**

The decision is bound by 6 conditions (Section "Conditions" below). These are not preferences — they are commitments. Slice D D.1 prototype must satisfy Conditions 2 and 3 before D.2+ implementation begins. Conditions 1, 4, 5 govern dependency choices that ship with D.1. Condition 6 is a tracked roadmap item, not a D.1 gate.

Forcing function `docs/future-roadmap.md` §10.11 ("HTTP framework choice for Cortex services") is **resolved by this ADR** — Hono is the answer.

## Consequences

### Positive

- **Tenant-context middleware integration is zero-cost.** `buildTenantContextMiddleware().hono(c, next)` already ships with structural test coverage. Slice D wires the adapter via `app.use('*', mw.hono)` and inherits the integration immediately.
- **OTel integration is mature.** `@hono/otel` middleware (framework-specific spans) + `@opentelemetry/auto-instrumentations-node` (HTTP server, `pg`, etc.) + `@opentelemetry/instrumentation-pino` (trace_id/span_id injection) compose with workspace's `createLogger` / `createTracer` from `@cortex/observability` without new infrastructure.
- **Error handling maps cleanly.** `app.onError(handler)` + `HTTPException` covers all 7 error classes from `@cortex/tenant-context` (`TenantContextError`, `TenantContextMissingError`, `TenantNotFoundError`, `TenantStatusError`, `TenantValidationError`, `TenantLegalHoldError`, `TenantGraceNotElapsedError`) with the workspace's existing error-code → HTTP-status mapping (CLAUDE.md §"Error responses": 400 VALIDATION, 401 UNAUTH, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT, 422 BUSINESS_RULE, 429 RATE_LIMIT, 500 INTERNAL).
- **TypeScript-first design.** Generic `Hono<{ Variables: { db: Database; tenantId: string } }>` typing supports the workspace's strict-mode + `exactOptionalPropertyTypes` posture. `c.set('db', boundDb)` / `c.get('db')` pattern composes with the RLS-bind lifecycle (`withTenantDbClient`).
- **Testing primitives match workspace patterns.** `app.request(path, init)` returns a `Response` for in-process integration testing — vitest-compatible, no HTTP listener needed, same shape as existing `tenants.terminate.spec.ts` / `force-terminate.spec.ts` patterns.
- **RFC 9457 Problem Details for error responses.** `hono-problem-details` middleware standardizes response shape per RFC 9457, aligning with CLAUDE.md's `{ code, message, correlation_id, details? }` envelope without writing custom serialization.

### Negative / Risks accepted

- **Bus factor (~10 contributors, single-maintainer-led by Yusuke Wada).** Mitigation: workspace's framework-agnostic library posture in `packages/tenant-context/src/middleware.ts` (ships both Hono and Express adapters) means HTTP-layer migration is a 2–3 day surface-only change for Slice D's 9 endpoints, not an architectural rebuild. Library code in `@cortex/tenant-context`, `@cortex/audit-events`, `@cortex/blob-storage`, etc. is framework-independent.
- **Cloud Run cold-start unmeasured.** No public Hono-on-Node-on-Cloud-Run benchmark exists. Inferred bound: 100–300ms range based on Lambda + small-bundle data. **Condition 2 binds D.1 to measure** — if p95 exceeds 500ms in production-like Cloud Run conditions, this ADR reopens for framework re-evaluation.
- **`@hono/zod-validator` lags Zod 4.** Workspace currently uses Zod 3 (catalog `^3.23.8`). When Zod 4 upgrade lands (timing TBD), validator middleware availability becomes a coupling point. **Condition 6 tracks** — non-blocking today.
- **`@hono/node-server` graceful-shutdown historical issue (#3104).** **Condition 3 binds D.1 to verify.** Risk if unresolved: container hangs through Cloud Run's 10s SIGTERM grace period before SIGKILL, causing dropped in-flight requests on deploys.

### Neutral

- Workspace gains 5–6 new dependencies (`hono`, `@hono/node-server`, `@hono/otel`, `@hono/zod-validator`, `hono-pino`, `hono-problem-details`). All small (Hono itself is ~14 KB), all under MIT license per spike investigation.
- D.1 prototype + D.2+ implementation work happen against this ADR's conditions, not against the spike's recommendation language.

## Conditions (binding)

These 6 conditions are binding constraints on Slice D D.1 prototype + D.2+ implementation. Each has a stated trigger that reopens this ADR if violated.

### Condition 1 — Pin to `^4.x` minor-version range

The workspace's `package.json` files MUST pin Hono and its companion packages to a minor-version range within Hono v4.x (e.g., `"hono": "^4.6.0"`). Major-version bumps to v5+ require reopening this ADR for re-evaluation.

**Rationale:** Hono v3→v4 migration (2024) had real TypeScript breaking changes (HonoRequest replaced Request, validator API changed, `c.jsonT()` removed). Major bumps imply migration cost; that cost should be evaluated explicitly, not absorbed silently.

**Reopen trigger:** intent to upgrade past v4.x (e.g., v5 ships and a feature we need is v5-only).

### Condition 2 — D.1 prototype instruments cold-start via OTel

D.1 prototype's first deployable build emits cold-start latency metrics (p50, p95, p99) via the workspace's `createTracer` / `createMetricsRegistry` from `@cortex/observability`. The OTel auto-instrumentation captures process startup → first-request-handled latency.

**Rationale:** HTTP API latency directly affects every consumer (Slice D's caller is SCR-24 Platform Ops Dashboard + W01 Tenant Onboarding Wizard initially; every F0X service downstream after). Cold-start tail latency on Cloud Run is a serverless-runtime trap: the first request after a scale-to-zero idle period absorbs the cost. The right answer is "measure," not "assume."

**Reopen trigger:** D.1 reports p95 cold-start > 500ms in Cloud Run staging conditions. The 500ms threshold is the spike's recommendation; lower is better but anything in the 300–500ms range is normal Cloud Run + Node behavior. Cause may be Hono, may be `pg` pool warmup, may be `@google-cloud/*` SDK init — **the ADR reopen requires diagnosis before deciding whether the framework choice or the architecture is at fault**.

### Condition 3 — D.1 verifies `@hono/node-server` graceful shutdown

D.1 prototype's first deployable build verifies that on `SIGTERM`, the server stops accepting new requests, waits for in-flight requests to complete, and exits cleanly within Cloud Run's 10-second SIGTERM grace period before `SIGKILL`. Test: deploy, hit the service with a slow endpoint (e.g., 5-second sleep), trigger a Cloud Run revision update mid-request, verify the in-flight request completes with 2xx + the new revision serves new traffic.

**Rationale:** GitHub issue [honojs/hono#3104](https://github.com/honojs/hono/issues/3104) flagged `@hono/node-server`'s `server.close()` not working in 2024. Subsequent fixes have shipped per spike investigation, but the 10-second Cloud Run window leaves no margin for "mostly works" — a single dropped request per deploy is a customer-visible bug.

**Reopen trigger:** D.1 cannot demonstrate clean SIGTERM behavior within 10 seconds across 3 sequential test deploys. If the issue is `@hono/node-server`-specific, switch to a vanilla `node:http` server with Hono as the request-handler library (Hono supports this — `app.fetch(req)` is the entry point).

### Condition 4 — Logging stack: `hono-pino`

The workspace's HTTP services use `hono-pino` (the canonical variant — most stars, downloads, and active maintenance per spike investigation) — NOT `hono-logger-pino` or other variants. `hono-pino` integrates with workspace's `createLogger` from `@cortex/observability` to produce structured logs with `tenant_id` (from `tenantContextProvider`), `correlation_id`, `request_id`, `trace_id`, `span_id` fields.

**Rationale:** Single canonical choice prevents future maintainability ambiguity. Variant proliferation in the Hono ecosystem (3+ pino-related middlewares) would otherwise create ad-hoc per-service choices.

**Reopen trigger:** `hono-pino` is unmaintained (no commits for 6+ months) AND a competing variant has materially better integration. Surface as ADR-HTTP-002 if it ships.

### Condition 5 — Error response shape: `hono-problem-details` (RFC 9457)

All HTTP error responses use the `hono-problem-details` middleware, which produces RFC 9457 `application/problem+json` envelopes with the workspace-extended fields per CLAUDE.md `{ code, message, correlation_id, details? }`. The standard RFC 9457 envelope `{ type, title, status, detail, instance }` carries the workspace-extended fields in extension members per RFC 9457 §3.2.

**Rationale:** RFC 9457 is the IETF standard for HTTP error envelopes; aligning Cortex's error responses with it gives downstream consumers (SCR-24 dashboard, future external API consumers, third-party integrators) a familiar contract. Workspace's existing error-envelope contract (CLAUDE.md §"Error responses") composes via RFC 9457's extension members — no contract loss.

**Reopen trigger:** RFC 9457 superseded (unlikely in 6–12 months) OR `hono-problem-details` unmaintained AND no clean replacement.

### Condition 6 — `@hono/zod-validator` ↔ Zod 4 coupling tracked

`@hono/zod-validator` currently lags Zod 4. Workspace is on Zod 3. When workspace plans the Zod 4 upgrade (timing TBD; likely Q3 2026 per Zod ecosystem signals), the upgrade plan MUST evaluate whether `@hono/zod-validator` has caught up OR whether a replacement validator middleware is needed (e.g., `@hono/typebox-validator`, hand-rolled `zValidator` shim).

**Rationale:** Zod 4 ships breaking changes; `@hono/zod-validator` is a tight coupling point. Surfacing it explicitly here means it doesn't become a surprise blocker during a future Zod 4 migration.

**Reopen trigger:** workspace begins Zod 4 upgrade work.

---

## Alternatives considered (briefly)

Per spike Section "Alternatives considered":

- **Express:** Most mature (~15 years); type ergonomics show their age (`@types/express` is functional but not type-safe across the middleware chain). Workspace already ships an Express adapter in `buildTenantContextMiddleware().express(...)` — migration path remains open if Hono's yellows light up. Trade-off: more friction for type-safe middleware composition; better long-term stability.
- **Fastify:** Mature performant alternative; JSON-Schema-first validation (vs Hono's Zod-first) means workspace's existing Zod schemas would need a JSON-Schema bridge; slightly heavier runtime. Trade-off: weaker fit with workspace's already-Zod-everywhere posture.
- **Vanilla Cloud Run + `node:http`:** Maximum control, maximum ongoing cost — reimplements middleware, error handling, validation, routing patterns the framework provides "for free." Rejected: Cortex's HTTP surface (~30+ endpoints by F02 close, ~100+ by Phase 2) makes the carrying cost too high.

## Verification

- **D.1 prototype** must report cold-start p95 (Condition 2) and SIGTERM behavior (Condition 3) before sub-phase D.1 lands as a commit on `main`. Failure of either condition reopens this ADR for framework re-evaluation BEFORE D.2+ implementation begins.
- **Conditions 1, 4, 5** are dependency-pin commitments — verified at D.1 dependency-add time and on every subsequent `pnpm install` / Renovate-style upgrade.
- **Condition 6** is a tracked roadmap item — captured in `docs/future-roadmap.md` (entry to be added when this ADR commits).

Future ADRs in the `HTTP-*` series may extend this decision (e.g., ADR-HTTP-002 for route-shape conventions, ADR-HTTP-003 for OpenAPI generation strategy, ADR-HTTP-004 for per-method authz post-AC01). This ADR scopes only the framework choice and the 6 conditions on it.

---

## References

- **Spike (informational):** `docs/spikes/2026-04-28-hono-prod-readiness.md` — 12-category investigation; Hono recommendation
- **F02 build prompt:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.2 (lines 997–1050)
- **F02 planning:** `docs/planning/f02-tenant-lifecycle-scope.md` D3 (HTTP framework forcing function)
- **Forcing function:** `docs/future-roadmap.md` §10.11 — resolved by this ADR
- **Workspace middleware adapter (already shipped):** `packages/tenant-context/src/middleware.ts` `buildTenantContextMiddleware().hono(c, next)`
- **Workspace error envelope contract:** CLAUDE.md §"Error responses"
- **Hono docs:** [hono.dev](https://hono.dev/), [Migration v3→v4](https://github.com/honojs/hono/blob/main/docs/MIGRATION.md), [HTTPException](https://hono.dev/docs/api/exception)
- **RFC 9457 — Problem Details for HTTP APIs:** [datatracker.ietf.org/doc/html/rfc9457](https://datatracker.ietf.org/doc/html/rfc9457)
- **GitHub issue #3104** (`@hono/node-server` graceful shutdown): [github.com/honojs/hono/issues/3104](https://github.com/honojs/hono/issues/3104)

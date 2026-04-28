# Spike: Hono HTTP framework prod-readiness for Cortex

**Date:** 2026-04-28
**Author:** Amit Boni (with Claude Code)
**Time-box:** ~60–90 min, doc-only
**Status:** Complete
**Decision:** **GO with conditions** — Hono is prod-ready for Cortex's Phase 1 surface; ADR-HTTP-001 codifies the choice + the conditions before Slice D HTTP code lands.

> First entry under `docs/spikes/`. Convention established here: doc-only time-boxed investigations with green/yellow/red flag findings + concrete recommendation. ADRs codify decisions; spikes inform them.

---

## Context

F02 Slice D ships an HTTP API exposing Cortex's tenant lifecycle workflows (`provision`, `suspend`, `resume`, `offboard`, `terminate`, `forceTerminate`, `legalHolds.set`/`release`, plus `rotateKeys`). The framework choice shapes Slice D's surface plus all subsequent F0X HTTP work.

Hono was the structural pick during F02 planning (planning-doc D3 + roadmap §10.11). The workspace already ships `buildTenantContextMiddleware().hono(c, next)` as a Hono adapter (`packages/tenant-context/src/middleware.ts`) — the structural commitment exists at the middleware layer. This spike's job is to verify Hono's prod-readiness for Cortex's specific patterns:

- **Tenant-context middleware** (header extraction → `withTenantContext` async-local bind)
- **Observability stack** — `@cortex/observability` ships `createLogger` / `createTracer` / `createMetricsRegistry` over OTel + pino + prom-client. Logger composition pattern: `composeContextProviders(defaultContextProvider, tenantContextProvider)` injects tenant_id into log fields.
- **Audit emit** — `emitAuditEvent(tx, ...)` is transactional; called inside a tx that owns the RLS bind. Framework needs to give a clean place to wire `withTenantDbClient` per request.
- **RLS bind lifecycle** — per-request connection acquisition + `bindTenantToDbSession` + release. Workspace pattern is `withTenantDbClient(pool, tenantId, fn)`.
- **Cloud Run runtime** — Node 22 LTS + `@hono/node-server`; SIGTERM graceful shutdown; healthcheck endpoints.

---

## Investigation

12 categories. Green = ready as-is; yellow = needs adapter or workspace-specific pattern but workable; red = genuine blocker.

### 1. Maturity signals — 🟡 yellow

- **30.2k GitHub stars; ~14.5M weekly npm downloads.** Healthy release cadence (≥1 release in past 3 months). Created Dec 2021 by Yusuke Wada.
- **Bus-factor concern:** ~10 or fewer contributors per public discussions; the project is effectively maintained by a small core. Cloudflare uses + sponsors Hono, which buys some commercial backing, but the contributor ratio is the spike's clearest yellow flag.
- **Production users at scale:** UseScraper.com (Cloudflare Workers), Portkey AI (Workers + Node), Ponder.ly (Railway + Node). No FAANG-scale references on Node specifically; most production references are Workers/edge contexts.

### 2. Cloud Run fit — 🟡 yellow

- **Node 22 supported** via `@hono/node-server` (`hono/node-server` import). Documented as a first-class Cortex-relevant target.
- **Cold-start benchmarks are NOT directly available for Cloud Run.** Most Hono benchmarks are Cloudflare Workers (sub-5ms cold start) or AWS Lambda Node.js (~102ms). For Cloud Run on Node 22, no public Hono benchmark exists. Likely behaves like any small Express/Fastify app — 100–300ms cold start range — but unverified.
- **Bundle size:** Hono claims ~14 KB; orders of magnitude smaller than Express + middleware. Translates to faster `require()` chains during cold start.
- **Recommendation:** Treat cold-start as "should be fine" but verify via the first deployed Slice D service. If cold-start exceeds 500ms p95, revisit.

### 3. TypeScript fit — 🟢 green

- **Generic-typed Context** via `Hono<{ Variables: { db: Database; tenantId: string } }>` — type-safe `c.set('db', value)` / `c.get('db')`. Maps cleanly onto our tenant-context + RLS-bound-db-client pattern.
- **`c.req` is `HonoRequest`** (Hono's wrapper). Underlying `Request` is `c.req.raw` — already used in `buildTenantContextMiddleware`.
- **Validator middleware (`@hono/zod-validator`)** preserves request shape generics through the handler chain — type narrowing works.
- **Strict-mode compatible:** workspace's `tsconfig` (strict + exactOptionalPropertyTypes) — Hono's published types are clean per multiple StackOverflow / community reports.

### 4. OTel integration — 🟢 green

- **`@hono/otel` middleware** exists for framework-specific span generation (route name, HTTP status as span attributes).
- **`@opentelemetry/auto-instrumentations-node`** auto-instruments HTTP server, `pg`, Redis, etc. — composes with `@hono/otel` cleanly. Workspace's existing tracer (`@cortex/observability`) plugs in as the SDK provider.
- **Manual span creation** via `withSpan(...)` from `@cortex/observability` works in any handler — Hono's middleware lifecycle doesn't interfere with OTel context propagation.

### 5. Logging integration — 🟢 green

- **Multiple `hono-pino` middleware packages** (3 variants found: `hono-pino`, `@bramanda48/hono-pino`, `hono-pino-logger`). Variant choice is a small ADR.
- **`@opentelemetry/instrumentation-pino`** injects trace_id + span_id into pino log records — works with workspace's `createLogger({ contextProvider })` pattern.
- **Workspace's `createLogger` consumes `ContextProvider`** which Hono's middleware can populate via `c.set('logFields', ...)`. Already an established pattern in `packages/observability/src/compose-context-providers.ts`.

### 6. Error handling — 🟢 green

- **`app.onError(handler)`** is the centralized error-translation hook. Catches uncaught throws from handlers + middleware.
- **`HTTPException` class** — throw with status code + message; or with custom Response. Maps cleanly onto workspace's error hierarchy:
  - `TenantValidationError` → `HTTPException(400, ...)`
  - `TenantNotFoundError` → `HTTPException(404, ...)`
  - `TenantStatusError` → `HTTPException(409, ...)`
  - `TenantLegalHoldError` → `HTTPException(409, ...)` (or 423 Locked)
  - `TenantGraceNotElapsedError` → `HTTPException(409, ...)`
- **RFC 9457 Problem Details middleware** (`hono-problem-details`) standardizes error response shape — aligns with CLAUDE.md's `{ code, message, correlation_id, details? }` envelope without us having to write the shape ourselves.

### 7. Tenant-context middleware composition — 🟢 green

- **Already shipped.** `buildTenantContextMiddleware().hono(c, next)` works structurally. Adapter consumes `c.req.raw.headers` + `c.req.path`; calls `withTenantContext(tenantId, runDownstream)` to set the async-local store for the handler chain.
- **Test coverage exists** (`packages/tenant-context/test/middleware.spec.ts`) — structural Hono pattern verified.
- **Slice D wires the adapter into `app.use('*', buildTenantContextMiddleware(...).hono)` and benefits immediately.** No further integration work needed at this layer.

### 8. Audit emit lifecycle — 🟢 green

- **Audit emits inside the request txn**, not after-response. Workspace's `emitAuditEvent(tx, ...)` is called from within `db.transaction(async (tx) => { ... })` — synchronous from the framework's point of view. Hono returns the response only after the handler resolves; the txn commits before response.
- **Cloudflare Workers' `c.executionCtx.waitUntil()`** is for after-response work — Cortex doesn't have that pattern (audit is in-txn). On Node, `waitUntil` is a no-op shim; doesn't apply here.
- **Failure semantics:** if audit emit throws, the txn rolls back, the handler propagates the error, and `app.onError` translates to a 500 with a logged correlation id. Existing convention §6.6 patterns hold.

### 9. RLS bind lifecycle — 🟢 green

- **Workspace pattern:** `withTenantDbClient(pool, tenantId, async (boundDb) => { ... })` — opens a pooled connection, binds `app.tenant_id`, runs the callback, releases.
- **Hono integration shape:** a middleware that runs after `buildTenantContextMiddleware`, reads the bound tenant id, and calls `withTenantDbClient`. The callback runs the rest of the handler chain via `await next()`. Set `c.set('db', boundDb)` so handlers receive the bound db via `c.get('db')` — type-safe via Hono generics (§3).
- **Connection-per-request model** matches Cloud Run's request-scoped lifecycle. Pool is per-process; per-request acquire+release is standard.

### 10. Validation — 🟡 yellow

- **`@hono/zod-validator`** is the canonical validator. Reuses workspace's existing Zod schemas (e.g., `idSchema`, `actorSchema`).
- **Caveat:** the validator middleware **lags Zod 4** (open issue: `[@hono/zod-validator] Upgrade to zod 4` #1148). Workspace currently uses Zod 3 (per pnpm-workspace.yaml catalog), so this is **not blocking today** — but couples a future Zod 4 upgrade to the validator's release cadence.
- **Type narrowing through `zValidator(...)`** preserves the validated shape into the handler — `c.req.valid('json')` returns the Zod-inferred type. Strong DX.

### 11. Testing — 🟢 green

- **`app.request(path, init)`** — in-process integration test API. Construct request via `Request` constructor; get `Response` back. No HTTP listener needed; vitest-friendly.
- **Workspace pattern fit:** existing tests (e.g., `packages/quotas/test/middleware.spec.ts`) already use Hono structurally without binding to runtime. Slice D tests can use `app.request` to hit handlers directly with a real DB connection — same pattern as `tenants.terminate.spec.ts` etc.
- **No additional test infra needed.**

### 12. Operational — 🟡 yellow

- **Graceful shutdown documented** (Hono discussions #3731, #3756): `serve(app)` returns a Node `http.Server`; register `SIGTERM`/`SIGINT` handlers calling `server.close(callback)`. Pattern is standard Node.js, not Hono-specific.
- **Historical issue #3104** (`@hono/node-server` server.close not working) — flagged in 2024 but has had subsequent fixes; needs **a 5-minute verification** during Slice D's first deployable build. Risk if not resolved: container hangs through SIGTERM grace period.
- **Healthcheck endpoint pattern:** trivial — `app.get('/health', (c) => c.text('ok'))`. Skip-paths in `buildTenantContextMiddleware` already handles bypassing tenant-context for `/health`.
- **Readiness signal:** Cloud Run uses startup-probe TCP port readiness; no Hono-specific work needed.
- **Warmup:** Cloud Run minInstances=1 + first-request warmup. Hono's small bundle helps.

### Summary

| Category                     | Flag      |
| ---------------------------- | --------- |
| 1. Maturity signals          | 🟡 yellow |
| 2. Cloud Run fit             | 🟡 yellow |
| 3. TypeScript fit            | 🟢 green  |
| 4. OTel integration          | 🟢 green  |
| 5. Logging integration       | 🟢 green  |
| 6. Error handling            | 🟢 green  |
| 7. Tenant-context middleware | 🟢 green  |
| 8. Audit emit lifecycle      | 🟢 green  |
| 9. RLS bind lifecycle        | 🟢 green  |
| 10. Validation               | 🟡 yellow |
| 11. Testing                  | 🟢 green  |
| 12. Operational              | 🟡 yellow |

**8 green / 4 yellow / 0 red.** No blockers; 4 yellows are manageable risks tracked under Risks below.

---

## Risks

### R1 — Maintainer bus factor (6-month + 12-month)

**Concern:** ~10-or-fewer contributors per public discussions; primary maintainer is Yusuke Wada. If maintenance slows in 2027 (illness, new role, Cloudflare deprioritizes), Cortex inherits a stale framework.

**Mitigation:** workspace's framework-agnostic `buildTenantContextMiddleware` precedent — both Hono and Express adapters ship today. If a migration is forced, the middleware layer is portable; only handlers + app composition would need rewriting. **Migration cost estimated ~2-3 days for Slice D's surface (8 endpoints).** Acceptable.

### R2 — Major-version breaking changes (12-month)

**Concern:** v3→v4 (2024) had real TypeScript breaking changes (HonoRequest, validator API, c.jsonT() removed). Another major version (v5+) could repeat the disruption.

**Mitigation:** ADR-HTTP-001 should pin Hono to a minor-version range (`~^4.x`) and require a planning-doc revisit before any major bump. Hono's MIGRATION.md is well-maintained — diff is readable.

### R3 — Cloud Run cold-start unmeasured (6-month)

**Concern:** No public Cloud Run benchmark for Hono on Node. We're inferring from Lambda + Workers numbers.

**Mitigation:** **Slice D's first deployable build** captures p50/p95/p99 cold-start metrics via OTel. If p95 exceeds 500ms, revisit (likely root cause: `pg` pool warmup or `@google-cloud/*` SDK init, NOT Hono — but worth measuring). **Mitigation cost: zero — measurement is free, since OTel is already wired.**

### R4 — Zod 4 upgrade coupling (12-month)

**Concern:** `@hono/zod-validator` lags Zod 4. When workspace upgrades to Zod 4 (likely Q3 2026 per ecosystem signals), validator will need to either follow or be replaced.

**Mitigation:** Phase 1 stays on Zod 3 for the foreseeable future (workspace uses `zod: catalog: ^3.23.8`). The Zod 4 upgrade is a deliberate workspace-wide event; we'd time it after the validator catches up or replace the validator at the same time. Tracked, not blocking.

### R5 — Lock-in risk

**Concern:** "If this goes wrong, what's the exit?"

**Mitigation:** all Cortex business logic lives in `@cortex/tenant-context` / `@cortex/audit-events` / `@cortex/blob-storage` etc. — framework-independent libraries. The HTTP layer is thin (route → call library function → translate result to Response). Migration to Express, Fastify, or another framework affects only the HTTP composition layer (estimated ~2-3 days for Slice D's surface). Substrate is portable.

---

## Alternatives considered

### Express

**Most mature.** Battle-tested for ~15 years; massive ecosystem; structural adapter already exists in workspace (`buildTenantContextMiddleware().express(...)`). TypeScript ergonomics show their age — types weren't designed in; community types via `@types/express` are functional but not type-safe across the middleware chain (request augmentation requires module declaration merging). Cold start similar to Hono on Node. **Trade-off: more friction for type-safe middleware composition; better long-term stability.** Would be the safe choice if Hono had a red flag — it doesn't.

### Fastify

**Mature performant alternative.** JSON-Schema-first validation (vs Hono's Zod-first), strong plugin ecosystem, smaller community than Express but larger than Hono. Type ergonomics better than Express but heavier than Hono. Would require workspace to add a Fastify adapter to `buildTenantContextMiddleware` — small but real cost. **Trade-off: better validation story for non-Zod consumers; slightly heavier runtime than Hono; weaker fit with workspace's already-Zod-everywhere posture.**

### Vanilla Cloud Run + std lib (`node:http`)

**Simplest in concept.** No framework dependency; full control. Reimplements middleware composition, error handling, validation, and routing — patterns we'd then own and maintain. **Trade-off: maximum control, maximum ongoing cost.** Rejected for Phase 1: Cortex's HTTP surface (~30+ endpoints by F02 close, ~100+ by Phase 2) makes the framework's "free" middleware composition pay back quickly.

---

## Recommendation

**GO with conditions.**

Hono is prod-ready for Cortex's Phase 1 surface. The integration story is strong (8/12 green; tenant-context adapter already shipped); the yellows are manageable risks, not blockers; the alternatives don't materially win.

### Conditions for ADR-HTTP-001

The ADR codifying this choice should require:

1. **Pin to a minor-version range** (`^4.x`); planning-doc revisit before major bump.
2. **Slice D's first deployable build instruments cold-start** via OTel (p50/p95/p99); revisit if p95 > 500ms.
3. **Evaluate `@hono/node-server` graceful shutdown** during Slice D's first deployable build; verify SIGTERM completes outstanding requests within Cloud Run's 10s grace window.
4. **Pick one `hono-pino` variant** in the ADR (recommend `hono-pino` itself — most stars/downloads). Don't leave the choice open.
5. **Pick `hono-problem-details` for error response shape** — aligns with CLAUDE.md's `{ code, message, correlation_id, details? }` envelope; saves us from writing a shape ourselves.
6. **Track the Zod 4 / `@hono/zod-validator` coupling** as a roadmap item; revisit when workspace plans the Zod 4 upgrade.

### What's NOT a condition

Migrating away from Hono if a yellow lights up — the workspace's framework-agnostic library posture means migration is a 2-3 day surface change, not an architectural rebuild. Yellow flags are honest disclosure, not roadblocks.

### Follow-up

- **ADR-HTTP-001** (next session): codifies the choice + the 6 conditions above. ~50-80 lines.
- **Slice D sub-phase D.1** (after ADR): the Hono prod-readiness _prototype_ — wire `@cortex/observability`, `buildTenantContextMiddleware`, `withTenantDbClient`, `app.onError(...)` for one endpoint (`/health` + `/v1/tenants/{id}` GET). Validates cold-start, graceful shutdown, OTel + pino traces. ~1 working day.
- Slice D sub-phase D.2+: full HTTP API for the 8 lifecycle workflows.

---

## Open questions

1. **Cloud Run cold-start measurement.** The doc-only spike couldn't measure this. Resolves at Slice D D.1.
2. **`@hono/node-server` graceful shutdown verification.** Issue #3104's resolution status as of 2026-04-28 unclear from doc-only investigation. Resolves at D.1 with a manual SIGTERM test.
3. **`hono-pino` variant choice.** Three exist; doc-only spike doesn't have grounds to pick. Defer to ADR-HTTP-001 with a quick npm-stats look at variant downloads.
4. **Per-method authz integration with Cloud Run service-to-service IAM (D8 lock).** Slice D's scope, not this spike's. Hono doesn't preclude any pattern; verifying is part of D.1.

---

## Sources

- [Hono — Web framework built on Web Standards](https://hono.dev/)
- [Hono — Node.js getting started](https://hono.dev/docs/getting-started/nodejs)
- [Hono — Migration Guide (v3 → v4)](https://github.com/honojs/hono/blob/main/docs/MIGRATION.md)
- [Hono — Logger middleware](https://hono.dev/docs/middleware/builtin/logger)
- [Hono — HTTPException API](https://hono.dev/docs/api/exception)
- [Hono — Validation guide](https://hono.dev/docs/guides/validation)
- [Hono — Best Practices](https://hono.dev/docs/guides/best-practices)
- [Hono — Benchmarks](https://hono.dev/docs/concepts/benchmarks)
- [Hono — Who is using Hono in production?](https://github.com/orgs/honojs/discussions/1510)
- [Hono — Graceful shutdown discussion #3756](https://github.com/orgs/honojs/discussions/3756)
- [Hono — `@hono/node-server` close issue #3104](https://github.com/honojs/hono/issues/3104)
- [Hono — `[@hono/zod-validator] Upgrade to zod 4` issue #1148](https://github.com/honojs/middleware/issues/1148)
- [Hono — npm package](https://www.npmjs.com/package/hono)
- [base14 Scout — Hono OpenTelemetry instrumentation guide](https://docs.base14.io/instrument/apps/auto-instrumentation/hono/)
- [`@opentelemetry/instrumentation-pino`](https://www.npmjs.com/package/@opentelemetry/instrumentation-pino)
- [`hono-pino` (bramanda48)](https://github.com/bramanda48/hono-pino)
- [`hono-pino` (maou-shonen)](https://github.com/maou-shonen/hono-pino)
- [`hono-problem-details`](https://github.com/paveg/hono-problem-details)
- [Snyk — Hono security advisories](https://security.snyk.io/package/npm/hono)
- [Express vs Hono in 2026 — PkgPulse Blog](https://www.pkgpulse.com/blog/express-vs-hono-2026)
- [Hono.js in 2026 — DEV Community](https://dev.to/ottoaria/honojs-in-2026-the-fastest-web-framework-for-cloudflare-workers-and-why-its-going-mainstream-2aap)
- [Fastify vs Express vs Hono — Better Stack Community](https://betterstack.com/community/guides/scaling-nodejs/fastify-vs-express-vs-hono/)

# Audit events

> Relocated from CLAUDE.md for context-budget; loaded on demand.

- Follow `/docs/architecture/audit-event-convention.md`
- Every mutating service method emits an audit event via `@cortex/audit-events`

### P0.10+ - library-driven emission

Compliance audit chain lives in `@cortex/audit-events`. Modules emit via `emitAuditEvent(tx, params)` from a tenant-bound transaction. Each module owns its action catalog (declared via `registerAuditActions([...] as const)` in a side-effect-free file like `audit-actions.ts`).

Verb-driven discriminated union enforces before/after-state requirements at compile time: CREATE → `after_state` only, UPDATE → both, DELETE → `before_state` only, READ → neither, APPROVE/REJECT/EXECUTE → caller's choice. The library auto-stamps `occurred_at = clock_timestamp()` per planning-doc Decision 11; callers don't supply it. Payload uses snake_case on the wire (TS API uses camelCase) - canonicalization handles the mapping.

When emitting from a new module, see `/docs/architecture/audit-event-convention.md` for the full pattern. Recurring gotchas:

- Optional fields (`actorDescription`, `sessionId`, etc.) require conditional spread under `exactOptionalPropertyTypes` - passing `undefined` is rejected; the field must be omitted.
- `@cortex/observability` is imported **statically** (`import { createLogger } from '@cortex/observability'`). The dynamic-import-as-cycle-defense pattern from the P0.10/Slice B era is **retired** (resolved 2026-04-27 by `ebb14ca` - see roadmap §4.13). Both `@cortex/observability` AND `@cortex/audit-events` are leaves w.r.t. `@cortex/tenant-context` - neither imports it at runtime OR in test deps. New packages downstream of tenant-context must preserve the same leafness on both halves; turbo's package-graph view counts `devDependencies`.
- `defaultContextProvider` from `@cortex/observability` does NOT auto-resolve `tenant_id`. Apps wanting `tenant_id` in log fields explicitly compose `tenantContextProvider` from `@cortex/tenant-context` via `composeContextProviders` at startup: `createLogger({ contextProvider: composeContextProviders(defaultContextProvider, tenantContextProvider) })`. Libraries do NOT compose; they accept whatever `ContextProvider` their caller supplies via `createLogger` options.
- `vi.mock` targets must be side-effect-free at top level. Catalog declarations belong in a separate file (`audit-actions.ts` precedent in `@cortex/tenant-context`).
- Caller MUST `bindTenantToDbSession(tx, tenantId)` before `emitAuditEvent(tx, ...)` - without it, RLS denies the INSERT (SQLSTATE 42501) and surfaces as `AuditEventEmissionError`.

References: ADR-AU-001 (library shape), ADR-DB-003 (chain integrity), planning doc `docs/planning/p0-10-audit-events-scope.md` Decisions 1–11, roadmap §4.12 (Pub/Sub fan-out, deferred), §4.13 (observability ↔ tenant-context decoupling, **resolved 2026-04-27 / commit `ebb14ca`**).

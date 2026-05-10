# F05 Slice B — Versioning + history API

> Cross-ref: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 Slice B.
>
> **Populated at slice kickoff (HOLD #1).** This file is a placeholder created during F05 module-scoping so the per-slice scope-doc convention is in place when Slice B starts.

## §1 Slice goal

Ship the semver versioning helpers + history API on top of Slice A's substrate. Tenant pins to a major version by default; minor + patch auto-rollout. Historical schema retrievable as of any date via F03's `at_time_t` predicate (acceptance criterion 3 PASS).

HTTP API surface (Hono per ADR-HTTP-001) for the history queries.

## §2 Phase plan

Populated at slice HOLD #1. Anticipated phases:

- **B.1** — Semver helpers (`version.ts` — `bumpMajor` / `bumpMinor` / `bumpPatch`, pin-to-major-with-auto-rollout).
- **B.2** — History API readers (`history-api.ts` — `getSchemaAsOf(entityType, asOfDate)` over bi-temporal substrate).
- **B.3** — HTTP service decision (Q-NEW-F05B-2) + API routes (Hono).
- **B.4** — Tests covering acceptance criterion 3 + version semantics.

## §3 Q-NEW recommendations (pre-defined from module-scope §4)

- **Q-NEW-F05B-1** — HTTP API shape: REST vs RPC. **Recommendation: REST per ADR-HTTP-001 + Hono.** Endpoints: `GET /schemas/:entityType/version/:semver`, `GET /schemas/:entityType/history?asOf=...`. Lock at HOLD #1.
- **Q-NEW-F05B-2** — service location: new `services/schema-evolution-api/` vs extend `apps/tenant-lifecycle-api/`. **Recommendation:** new service for D11 module-discipline reasons. Lock at HOLD #1.

Additional Q-NEW items may surface during HOLD #1.

## §4 File surface anticipated

- `packages/schema-evolution/src/version.ts` (NEW) — semver helpers.
- `packages/schema-evolution/src/history-api.ts` (NEW) — history readers over bi-temporal substrate.
- `apps/schema-evolution-api/` OR `apps/tenant-lifecycle-api/src/routes/v1/schemas/...` (TBD per Q-NEW-F05B-2) — HTTP routes.
- `packages/schema-evolution/test/{version,history-api}.spec.ts` (NEW).
- `apps/schema-evolution-api/test/...` (NEW if new service path chosen).

## §5 Effort estimate

6-10 hr per module-scope §6. HTTP layer + tests dominate.

## §6 Locks

Populated at slice HOLD #1.

## §7 Lessons

Populated at slice close.

## §8 Cross-references

- Module scope: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 + §3 (D1 bi-temporal substrate Slice B reads from, D2 semver versioning lock).
- ADR-HTTP-001 (Hono framework choice).
- F03 `at_time_t` predicate: `services/foundation/migrations/0002_bi_temporal_helpers.sql`; `@cortex/temporal-query`'s `as-of` consumers.
- F02 Slice D HTTP API precedent at `apps/tenant-lifecycle-api/`.
- Build-prompt acceptance criterion 3: "Historical schema version retrievable for any entity as of any date."

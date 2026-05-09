# F03 Slice B — Gate evidence

> Captured 2026-05-09. Slice B — Temporal query library + `@cortex/test-db-harness` extraction.
> Branch: `p1.3-f03-slice-a` (continuation; squash bundles A + B per slice-as-squash discipline. Wait — branch is `p1.3-f03-slice-a` from prior; renaming to `p1.3-f03-slice-b` for this work).
> Higher-level scope: `docs/planning/f03-temporal-data-engine-scope.md`
> Slice B locks: D7, D8, Q-NEW-F03B-2 through Q-NEW-F03B-7 (operator pre-B.2 lock turn).

## §1 Acceptance criteria

| #   | Criterion                                                                                                                    | Status                                | Evidence                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 5 functions exposed as composable TS library; types preserved end-to-end (`BiTemporalRow<T>` returned)                       | PASS                                  | `packages/temporal-query/src/{as-of,current-state,history,between,diff}.ts`; barrel at `index.ts` re-exports. Type signatures use generic `<T>` flowing through; `mapRow<T>` deserializes via `parseTstzRange` from `@cortex/canonical-schema`.                                                                       |
| 2   | F03 spec acceptance test passes ("create retail.Product, update price, query 'as of last week' — returns last week's price") | PASS at code level; CI exercises live | `packages/temporal-query/test/temporal-query.spec.ts` — first `describe` block; INSERTs retail_product, captures id, updates price, asOf(prevId, tBetween) returns price=1000 (pre-update). Local `pnpm vitest run` blocked by carried-over §4.20 local-DB password issue; CI's ephemeral Postgres exercises on push. |
| 3   | No tRPC handlers + no SQL views in Slice B (Q-NEW-F03B-1 binding)                                                            | PASS                                  | Zero `trpc/` files; zero CREATE VIEW statements. Public surface = the 5 functions + `Queryable` type only.                                                                                                                                                                                                            |
| 4   | CLAUDE.md or convention §7 cross-reference to the new package                                                                | PASS                                  | CLAUDE.md `### Bi-temporal table convention` section gains a "Querying bi-temporal data" subsection listing the 5 functions + Q-NEW-F03B-5/6 locks (Queryable interface + explicit tenantId) + cross-ref to `packages/temporal-query/src/index.ts`.                                                                   |

## §2 Locks honored

All 8 operator locks from the pre-B.2 turn:

| Lock                                                                         | Implementation site                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D7 = new package                                                             | `packages/temporal-query/package.json` (private workspace package; depends on `@cortex/canonical-schema` only — `pg` is devDep, public surface uses `Queryable`)                                                                                                                                                                                                  |
| D8 = string-wire pass-through                                                | `src/_internals/serialize.ts` (Date → tstzrange wire); `src/_internals/deserialize.ts` (re-uses `parseTstzRange` from canonical-schema)                                                                                                                                                                                                                           |
| Q-NEW-F03B-2 = package-local fixtures + `@cortex/test-db-harness` extraction | B.0 lands `packages/test-db-harness/`; foundation + tenant-context migrate to harness; tenant-context keeps slim shim layer for `withBoundClient` / `withTwoBoundClients` (which need `bindTenantToDbSession` from tenant-context's own src — the harness can't depend on tenant-context). Fixture at `packages/temporal-query/test/fixtures/retail_product.sql`. |
| Q-NEW-F03B-3 = closed-open `[t1, t2)`                                        | `src/between.ts` uses `serializeTstzRange(from, to)` which always produces `["lo","hi")` form                                                                                                                                                                                                                                                                     |
| Q-NEW-F03B-4 = nullable returns                                              | `asOf` / `currentState` return `Promise<BiTemporalRow<T> \| null>`; `history` / `between` return `Promise<BiTemporalRow<T>[]>` (empty array; never null); `diff` returns `{ before \| null, after \| null, changedColumns }`                                                                                                                                      |
| Q-NEW-F03B-5 = `Queryable` interface                                         | `src/queryable.ts` defines `interface Queryable { query(sql, params): Promise<{ rows: unknown[] }> }`. No `pg.Pool` import in public surface (pg is devDep only)                                                                                                                                                                                                  |
| Q-NEW-F03B-6 = explicit `tenantId` on every function                         | All 5 functions take `tenantId` as 2nd positional arg; passed as `$2` in SQL (`tenant_id = $2`); RLS stays as defense-in-depth backstop                                                                                                                                                                                                                           |
| Q-NEW-F03B-7 = `diff` shape                                                  | `src/diff.ts` returns `{ before, after, changedColumns }`; `EXCLUDED = ['id', 'tenant_id', 'valid_time', 'txn_time']` (per sub-decision 2 — operator-confirmed); inline comment documents the four exclusions                                                                                                                                                     |

## §3 B.0 — `@cortex/test-db-harness` extraction

Two duplicate harnesses extracted into one workspace package:

**Pre-B.0:**

- `services/foundation/test/helpers/db.ts` — `getTestPool()` only; 6 callers
- `packages/tenant-context/test/helpers/db.ts` — `getPool` + `withBoundClient` + `withTwoBoundClients` + `forceRlsOnAuditEvent` + `Deferred`/`deferred`; 13 callers in tenant-context + 3 in apps/tenant-lifecycle-api

**Post-B.0:**

- New `@cortex/test-db-harness` exports generic primitives: `getPool`, `withTransactionalClient`, `withTwoTransactions`, `forceRlsOnAuditEvent`, `Deferred`/`deferred`
- `services/foundation/test/helpers/db.ts` DELETED; 6 foundation tests import `getPool as getTestPool` from `@cortex/test-db-harness` directly
- `packages/tenant-context/test/helpers/db.ts` slim shim (~70 lines): re-exports `getPool` / `forceRlsOnAuditEvent` / `Deferred` / `deferred` from harness; keeps tenant-bound `withBoundClient` / `withTwoBoundClients` shims that wrap the harness's generic primitives + add `bindTenantToDbSession` calls. The bind-logic stays in tenant-context to avoid a harness → tenant-context circular dep.

Reasoning + rationale for the SHIM-over-extract decision is captured inline in `packages/tenant-context/test/helpers/db.ts` header comment.

## §4 Sub-decisions resolved

| Sub-decision                              | Resolution                                                                                                 | Rationale                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Column-name typo in Q-NEW-F03B-7      | `valid_time` / `txn_time` (not `valid_period_t` / `system_period_t`)                                       | Workspace's actual column names per ADR-DB-001 §1 + migration 0002                                                                                                                                                                                                                                                                                                                      |
| 2 — `id` + business-key in changedColumns | EXCLUDED = `['id', 'tenant_id', 'valid_time', 'txn_time']`. Business-key columns NOT excluded.             | (a) `id` rotates per SCD version (NEW.id := gen_random_uuid()), so it's row-version identity — including would tautologically report id-changed. (b) `tenant_id` is universal scoping, never an entity-level domain change. (c) `valid_time` / `txn_time` are SCD bookkeeping by recipe. (d) Library cannot know per-table which column is business-key; caller post-filters if needed. |
| 3 — B.0 extraction scope                  | APPROVED; +1.5 hr to Slice B (4-6 → 6.5 hr); B.0 inside Slice B's squash per F02 slice-as-squash precedent | Q-NEW-F03B-2 lock spirit: "do not centralize fixtures under services/foundation/test/" + "extract to @cortex/test-db-harness". Adding a third duplicate harness in temporal-query/test/ would directly violate the lock.                                                                                                                                                                |

## §5 Test coverage

| Spec                                                  | Cases                                                                                                               | Status                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/temporal-query/test/temporal-query.spec.ts` | 13 cases covering all 5 functions + F03 acceptance scenario + tenant-scope + null semantics + table-name validation | written; CI-runnable (local-DB §4.20 blocked)     |
| Slice A specs (lint + scaffold)                       | 14 cases                                                                                                            | 14/14 PASS post-B.0 extraction (verified locally) |

Lint + typecheck CLEAN across:

- `@cortex/test-db-harness`
- `@cortex/temporal-query`
- `@cortex/foundation` (post-import-migration)
- `@cortex/tenant-context` (post-shim)

## §6 Multi-phase close timeline checkpoint

Per `docs/planning/f03-temporal-data-engine-scope.md` § Multi-phase close timeline:

| Slice | Status post-this-commit                  |
| ----- | ---------------------------------------- |
| **A** | ✓ closed (commit `2d3782e`)              |
| **B** | ✓ closed (this commit)                   |
| **C** | DEFERRED (blocked by F04)                |
| **D** | DEFERRED (blocked by D04 + S01 + SCR-08) |

F03 module-row stays unchecked per D4 (per-slice rows; flips at all-4-slices ✓).

## §7 What's next

- F03 Slice C (DEFERRED — blocked by F04 close).
- F03 Slice D (DEFERRED — blocked by D04 + S01 + SCR-08).
- Module close: P1.3 work for F03 is COMPLETE pending those deferrals; partial-close shape per `f03-temporal-data-engine-scope.md`.
- Operator-driven recovery still pending (carried from D.4–D.6 close): re-attach billing on staging+prod per roadmap §2.5a → apply 5 accumulated TF bundles.
- Roadmap §4.20 (local DB credentials reconciliation) carries forward — Slice B also hit it; chose not to side-quest fix per scope discipline.

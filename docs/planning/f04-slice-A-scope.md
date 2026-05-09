# F04 Slice A — Storage substrate + Zod registry + read API

> Cross-ref: `docs/planning/p1.4-f04-configuration-plane-scope.md` §2 Slice A.
>
> Populated 2026-05-09 at HOLD #1 kickoff. Slice A is the storage-substrate + read-API foundation for F04. Slice A is **read-only** per D8 sub-lock — no write API ships in this slice; F02 keeps writing v=1 via Drizzle (reconciled in this slice's commit set), and Slice B introduces the user-driven write path (draft/validate/promote/rollback).

## Sub-decision locks (HOLD #1)

| ID                | Lock                                                                                                                                                          | Rationale                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-F04A-1**  | tenant_config_version reshape via single migration 0014 (per Q-NEW-F04A-9 override)                                                                           | One coherent F04-prep shape change, not two unrelated migrations                                                                       |
| **Q-NEW-F04A-2**  | Zod schema registry keyed on `(namespace, version)` tuple; per-version isolation                                                                              | Drafts pinned to v=1 keep validating against v=1 even after v=2 ships                                                                  |
| **Q-NEW-F04A-3**  | Package name `@cortex/config-plane` (PRE-RESOLVED at HOLD #0)                                                                                                 | n/a                                                                                                                                    |
| **Q-NEW-F04A-4**  | Audit-actions catalog at `packages/config-plane/src/audit-actions.ts`, side-effect-free top level                                                             | Mirrors `@cortex/tenant-context/src/audit-actions.ts` precedent; vi.mock-safe per CLAUDE.md gotcha                                     |
| **Q-NEW-F04A-5**  | Read API always async (`Promise<T \| null>`)                                                                                                                  | Cache-hit-sync would double the API surface for microsecond-scale gain; D4's "sub-10ms cached" is about latency not API shape          |
| **Q-NEW-F04A-6**  | Migration backfill verification via cheap-simulate pattern (DROP COLUMN → INSERT old-shape → re-add column → UPDATE)                                          | Verifies the UPDATE statement covers the right cases; ~30-45 min implementation cost absorbed inside A.1's 1.5-2 hr range              |
| **Q-NEW-F04A-7**  | F02 reconciliation surface = 2 files (canonical-schema's Drizzle definition + tenants.ts:347 writer); export-archive + provisioning-worker forward-compatible | Drizzle insert (not raw SQL); SELECT \* + DELETE WHERE tenant_id ride along                                                            |
| **Q-NEW-F04A-8**  | Defer `listNamespaces` API per YAGNI                                                                                                                          | No Phase 1 consumer needs enumeration                                                                                                  |
| **Q-NEW-F04A-9**  | Single migration 0014 covers all D9+D12 reshape (NOT split 0014+0015)                                                                                         | Operator override: "one migration at a time" prohibits unrelated changes, not coherent F04-prep                                        |
| **Q-NEW-F04A-10** | F02's `TENANT_CONFIG_VERSION_CREATED` and F04's `CONFIG_VERSION_PROMOTED` COEXIST                                                                             | Different conceptual events (substrate-bootstrap vs user-driven); pre-locked at Slice A HOLD #1 to avoid Slice B HOLD #1 re-litigation |

## Build plan (A.1 - A.7)

| Step      | Scope                                                                                                                                                                                  | Estimate     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **A.1**   | Migration 0014 + reshape + backfill test (cheap-simulate pattern)                                                                                                                      | 1.5-2 hr     |
| **A.2**   | `@cortex/config-plane` package scaffold (package.json, tsconfig, vitest config, index.ts barrel)                                                                                       | 0.5 hr       |
| **A.3**   | Zod schema registry (registerNamespaceSchema / getNamespaceSchema / resetSchemaRegistry; tests for register, lookup, conflict, idempotent, per-version isolation, namespace isolation) | 1.5 hr       |
| **A.4**   | Audit actions catalog (6 verbs registered; tests for catalog completeness + verb semantics)                                                                                            | 0.5 hr       |
| **A.5**   | `getConfig` read API (Queryable seam, Zod validation, NamespaceSchemaNotRegisteredError; integration tests using withTenantContext for RLS-aware queries)                              | 1.5-2 hr     |
| **A.6**   | F02 reconciliation (Drizzle schema + tenants.ts:347 writer; existing test INSERTs across foundation + tenant-context updated to include `namespace`)                                   | 1-1.5 hr     |
| **A.7**   | CLAUDE.md `## Configuration plane (F04)` section + this scope doc + module-scope §0 line-citation correction (tenants.ts:355 → :347)                                                   | 0.5-1 hr     |
| **Total** |                                                                                                                                                                                        | **7-9.5 hr** |

## Acceptance — module scope §2 deliverables

- ✓ Migration 0014 applies cleanly to `make db:init-test` baseline (verified live).
- ✓ F02's existing 68-test foundation suite + 255-test tenant-context suite pass unchanged after writer reconciliation. **F02 test-INSERT call sites discovered during A.6** required updates beyond the Drizzle writer — 7 INSERT statements across `services/foundation/test/control_plane.spec.ts` (3 sites) and `packages/tenant-context/test/db-session.spec.ts` (4 sites) needed `namespace='tenant'` added to the column list. Surfaces a §0 update for the module-scope risk register: **F02 reconciliation surface is 2 source files + ~7 test-fixture INSERT sites**, not just 2 source files.
- ✓ New `@cortex/config-plane` package: typecheck + lint + 18 tests green (4 specs: audit-actions 5 / schema-registry 6 / migration-0014-backfill 1 / get-config 6).
- ✓ Audit catalog symbols visible to consumers (Slice B will emit).
- ✓ `getConfig` returns `null` for missing rows; throws `NamespaceSchemaNotRegisteredError` when row exists but no schema registered for `(namespace, schema_version)`; throws `ZodError` on validation failure; returns the highest `version_number` row when multiple versions exist.

## Findings during A.1-A.7

1. **F02 writer is Drizzle, not raw SQL** — confirmed in investigation. Reconciliation correctly targets `packages/canonical-schema/src/drizzle/schema.ts:137-155` + `packages/tenant-context/src/tenants.ts:347`.

2. **Test-INSERT call sites needed updating** — 7 sites across foundation + tenant-context tests insert into `tenant_config_version` with the OLD shape (no `namespace` column). Discovered during A.6 self-verification. Updated all 7 to include `namespace='tenant'`. Module scope §5 risk register implicitly covered this ("F02 reconciliation surface" — broadened in retrospect to include test-fixture writers).

3. **Postgres `ADD COLUMN ... DEFAULT 1`** — initially ADDed `schema_version` without DEFAULT, expecting Drizzle's `.default(1)` to handle it. Drizzle's application-side default fires only if the column has a DB-level default (otherwise INSERT translates `DEFAULT` keyword to NULL → NOT NULL violation). Migration was updated to `ADD COLUMN schema_version integer DEFAULT 1` so omit-the-column INSERT paths land on 1 cleanly. Postgres 11+ semantics: `ADD COLUMN` with a constant `DEFAULT` is fast (no rewrite) AND backfills existing rows with the default value — so the explicit `UPDATE schema_version = 1` step in the original migration design was unnecessary and got removed.

4. **Module scope §0 line-citation off-by-eight** — module scope cited `tenants.ts:355` (audit-emission line) when the writer is at `tenants.ts:347` (Drizzle insert line). Corrected in this slice's A.7 commit.

5. **Test ownership constraint** — `tenant_config_version` is owned by `postgres`; `test_user` (NOSUPERUSER NOBYPASSRLS) cannot ALTER the table. Migration-backfill spec uses a dedicated `postgres`-user `pg.Pool` for its DDL operations; `getConfig` integration spec uses `withTenantContext` from `@cortex/canonical-schema/rls-test` for RLS-aware INSERT/SELECT under `test_user`.

## Cross-feature unblock

None at this slice. F03 Slice C strict-minimum unblock is technically possible at Slice A close per D7, but operator chose Slice B operational unblock for safety (lifecycle ships before SCD-policy changes can be made safely).

## References

- Module scope: `docs/planning/p1.4-f04-configuration-plane-scope.md` (D1-D14 + Q-NEW-F04A surface)
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.4
- Migration: `services/foundation/migrations/0014_f04_config_namespace_reshape.sql`
- Drizzle schema: `packages/canonical-schema/src/drizzle/schema.ts:137-160` (post-Slice-A shape)
- F02 writer: `packages/tenant-context/src/tenants.ts:347-365` (post-reconciliation)
- Source: `packages/config-plane/src/{index,audit-actions,schema-registry,get-config,queryable}.ts`
- Tests: `packages/config-plane/test/{audit-actions,schema-registry,migration-0014-backfill,get-config}.spec.ts`

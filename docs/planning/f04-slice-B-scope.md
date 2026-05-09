# F04 Slice B — Lifecycle: draft / validate / promote / rollback

> Cross-ref: `docs/planning/p1.4-f04-configuration-plane-scope.md` §2 Slice B.
>
> Populated 2026-05-09 at HOLD #3 close. Slice B ships the user-driven write path for F04: `createDraft / updateDraft / validateDraft / promoteDraft / rollbackVersion / discardDraft` + `config_draft` table + 8 error classes + audit emissions for all 6 catalog verbs. F03 Slice C unblocks at this slice's close per D7 (operationally-safe lifecycle for SCD policy changes).

## Sub-decision locks (HOLD #1)

| ID                | Lock                                                                                           | Rationale                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q-NEW-F04B-1**  | UNIQUE `(tenant_id, namespace, created_by_user_id) WHERE status = 'active'`                    | At most one active draft per author per (tenant, namespace) — prevents author confusion. Discarded/promoted drafts free the slot.                                                          |
| **Q-NEW-F04B-3**  | Whole-namespace rollback only                                                                  | Per-key rollback contradicts D1 (the namespace IS the version atom). Rollback inserts new version with parent's content; `parent_version_id` points to the rolled-back-from version.       |
| **Q-NEW-F04B-5**  | `status` enum `'active'` / `'promoted'` / `'discarded'` + nullable `promoted_to_version_id` FK | Audit-trail-preserving: "which draft became which version" stays queryable post-promote. Aligns with B-1's UNIQUE-on-active.                                                               |
| **Q-NEW-F04B-6**  | Defensive re-validate on promote                                                               | Catches schema re-registration footgun between explicit `validateDraft()` and `promoteDraft()`. Cost is one Zod parse per promote; negligible.                                             |
| **Q-NEW-F04B-7**  | Optimistic UPDATE on `updated_at`                                                              | Two-tab-conflict surfaces explicitly as `DraftConcurrencyError` (HTTP 409). Matches D13 promote pattern across the codebase.                                                               |
| **Q-NEW-F04B-8**  | `Actor` accepts `'user' / 'service' / 'system'`                                                | F02 precedent. `actor.id` becomes `created_by_user_id` for drafts; column name retained for workspace consistency. Compliance auditors filter on `actor_type` if they need to distinguish. |
| **Q-NEW-F04B-9**  | Explicit `schemaVersion` on `createDraft`                                                      | Auto-resolve "latest" creates stale-validation footgun across schema-bump windows. Library exports `getLatestRegisteredVersion(namespace)` for callers that want "latest".                 |
| **Q-NEW-F04B-10** | F02's `TENANT_CONFIG_VERSION_CREATED` + F04's `CONFIG_VERSION_PROMOTED` coexist                | Different conceptual events: substrate-bootstrap (F02) vs user-driven promote (F04). Pre-locked at Slice A HOLD #1 to avoid Slice B HOLD #1 re-litigation.                                 |

## Build plan (B.0 - B.7)

| Step      | Scope                                                                                                          | Estimate      | Actual                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| **B.0**   | export-archive defensive ORDER BY fix (forward-compat for multi-namespace)                                     | 0.25 hr       | 0.25 hr                                                                                               |
| **B.1**   | Migration 0015 + `config_draft` table + Drizzle schema (canonical-schema) + UNIQUE + RLS + bi-temporal opt-out | 1.5 hr        | 1.5 hr                                                                                                |
| **B.2**   | Draft CRUD (`createDraft / updateDraft / discardDraft`) + Actor + `getLatestRegisteredVersion` helper          | 2-2.5 hr      | 2 hr                                                                                                  |
| **B.3**   | `validateDraft` + Zod parse + READ-verb audit with payload metadata                                            | 1.5-2 hr      | 1.5 hr                                                                                                |
| **B.4**   | `promoteDraft` + defensive re-validate + optimistic INSERT-with-retry + draft promotion + audit                | 2-2.5 hr      | 2 hr                                                                                                  |
| **B.5**   | `rollbackVersion` + whole-namespace + chain-integrity parent_version_id + audit                                | 1-1.5 hr      | 1 hr                                                                                                  |
| **B.6**   | Workspace-wide regression check (Slice A lesson)                                                               | 0.5 hr        | 0.75 hr (uncovered turbo-parallel pre-existing race; investigated + verified pre-existing on 873fb33) |
| **B.7**   | CLAUDE.md F04 lifecycle section + this scope doc + helper extraction                                           | 1 hr          | 1 hr                                                                                                  |
| **Total** |                                                                                                                | 9.75-11.25 hr | **~10 hr** (mid-range)                                                                                |

## Acceptance — module-scope §2 deliverables

- ✓ Migration 0015 applies cleanly to `make db:init-test` baseline (15 migrations, 9 public tables).
- ✓ F02's existing test suites pass unchanged (255/255 tenant-context, 68/68 foundation).
- ✓ `@cortex/config-plane` package: typecheck + lint + 65 tests green (was 18 post-Slice-A → +47).
- ✓ All 6 audit verbs emit on their respective lifecycle paths; READ-verb (`CONFIG_DRAFT_VALIDATED`) carries result metadata in `payload`; CREATE-verb derivatives (`CONFIG_VERSION_PROMOTED / ROLLED_BACK`) carry `after_state` with namespace + version_number + chain-pointer references.
- ✓ All 8 error classes exported from package barrel; consistent `*Error` naming.
- ✓ Optimistic concurrency on promote + rollback verified: UNIQUE-on-(tenant, namespace, version_number) catches conflicts; retry attempts twice; second 23505 → `*ConcurrencyError`.
- ✓ Audit-honesty contract: exactly 1 `CONFIG_VERSION_PROMOTED` row per successful promote regardless of retry. Documented inline in test + structurally enforced by emit-after-INSERT order inside transaction.

## Findings during B.0-B.7

### B.0 export-archive ORDER BY — Class-2 read-class (subtype: ORDER BY tightening)

Module scope §5 Risk Register's 3-class enumeration (Slice A's quotas miss caused codification) caught this preemptively. Old query: `SELECT * FROM tenant_config_version WHERE tenant_id = $1 ORDER BY version_number`. New: `ORDER BY namespace, version_number`. Forward-compat for multi-namespace exports. Currently safe (only `tenant` namespace exists post-F02-provisioning); future F04-promoted namespaces would interleave non-deterministically without the namespace tiebreaker.

### B.1 — bi-temporal opt-out directive required

`config_draft` is bookkeeping (queue of mutable drafts), not a domain entity. Per CLAUDE.md `### Bi-temporal table convention`, tenant-scoped non-bi-temporal tables not in the allowlist need an explicit `-- @bi-temporal: skip` directive. Added in the migration header. Lint exit-0 against `services/foundation/migrations/` confirmed.

### B.2 — Drizzle `tx.execute<T>` requires `T extends Record<string, unknown>`

Named interfaces don't structurally satisfy this constraint without explicit index signatures. Worked around by using inline type literals (`tx.execute<{ id: string; ... }>(sql\`...\`)`). Refactored two named-interface usages in `lifecycle.ts` rollback path during B.6 typecheck after they tripped TS in workspace-wide check.

### B.4 — Promote retry must wrap the whole transaction

Postgres aborts the transaction on first error; subsequent commands fail until ROLLBACK. So `attemptPromote` is a fresh-transaction call, and `promoteDraft` retries up to twice at the OUTER level. Each retry re-fetches the draft + re-validates → audit row count = number of successful promotes (not attempts).

### B.6 — Pre-existing local turbo-parallel race (NOT a Slice B regression)

`pnpm test` workspace-wide via turbo's parallel orchestration intermittently fails with shared-DB races (a different package per run — sometimes `@cortex/foundation`, sometimes `@cortex/temporal-query`). Verified pre-existing by stashing Slice B's work + checking out `873fb33` (original main HEAD) — same failure pattern.

**Working hypothesis:** `audit-chain.spec.ts` uses `ALTER TABLE audit_event FORCE ROW LEVEL SECURITY` in `beforeAll`. While that suite is mid-run, parallel suites in other packages inserting into `audit_event` see unexpected RLS behavior. CI passes the same `pnpm test` against ephemeral Postgres consistently — the race apparently doesn't manifest in CI's environment (timing-dependent).

**Mitigation for Slice B:** per-package serial run as the local pre-push gate. All 9 packages green serially (660+ tests total). CI is the canonical workspace-wide-parallel gate. **Not a Slice B blocker; pre-existing.**

**Future-roadmap candidate:** if the race becomes operationally noisy (developer confusion, repeated false negatives), worth scoping a fix (vitest `singleThread: true` at root, or test isolation via vitest workspace config). Tracking informally; not landed as a roadmap §X.Y entry yet.

### B.7 — `cleanupConfigPlaneState` helper extraction

Operator's HOLD #2 verify caught the inlined cleanup-chain duplication. Extracted to `packages/config-plane/test/_utils/cleanup.ts` exporting `cleanupConfigPlaneState(pool, tenantId)`. FK-safe order (audit_event → config_draft → tenant_config_version). All 3 specs that need it (`config-draft-constraints`, `lifecycle`, `rollback`) use it now. Future tests reuse rather than reinvent.

## Test inventory

| Spec                                                        | Tests                                 |
| ----------------------------------------------------------- | ------------------------------------- |
| `audit-actions.spec.ts` (Slice A; unchanged)                | 5                                     |
| `schema-registry.spec.ts` (+2 `getLatestRegisteredVersion`) | 8                                     |
| `migration-0014-backfill.spec.ts` (Slice A; unchanged)      | 1                                     |
| `get-config.spec.ts` (Slice A; unchanged)                   | 6                                     |
| `config-draft-constraints.spec.ts` (B.1)                    | 6                                     |
| `lifecycle.spec.ts` (B.2-B.4)                               | 27                                    |
| `rollback.spec.ts` (B.5)                                    | 6                                     |
| **Total**                                                   | **59** (was 18 post-Slice-A; +41 net) |

## Cross-feature unblock

**F03 Slice C unblocks at this slice's close** per D7 (operationally-safe lifecycle for SCD policy changes — operator chose Slice B close, not Slice A close). F03 Slice C lands as a follow-up commit/PR within P1.4 (between F04 Slice B and F04 Slice C).

## References

- Module scope: `docs/planning/p1.4-f04-configuration-plane-scope.md` (D1-D14 + Q-NEW-F04B surface + §5 Risk Register 3-class enumeration)
- Slice A scope: `docs/planning/f04-slice-A-scope.md` (Q-NEW-F04A locks; Q-NEW-F04A-10 pre-resolved B-coexistence)
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.4
- Migrations: `services/foundation/migrations/0015_f04_config_draft_table.sql`
- Drizzle schema: `packages/canonical-schema/src/drizzle/schema.ts:147-180` (configDraft pgTable)
- Source: `packages/config-plane/src/{lifecycle,types,schema-registry,index}.ts`
- Tests: `packages/config-plane/test/{lifecycle,rollback,config-draft-constraints,schema-registry}.spec.ts` + `_utils/cleanup.ts`
- Slice A's reconciliation lesson (Slice B's pre-emptive grep applied here): `CLAUDE.md ### Reshaping tenant-scoped substrate tables`

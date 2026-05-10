# F04 Slice E — Git sync stub + module wrap-up

> Cross-ref: `docs/planning/p1.4-f04-configuration-plane-scope.md` §2 Slice E + §3 Q-NEW-F04E.
>
> Populated 2026-05-10 at HOLD #3 close. Slice E ships the Configuration-as-Code Git-sync API surface as STUBS (Phase 2 deferred per build-prompt §F04 §4) and serves as the F04 module-close marker. `exportToYaml` / `importFromYaml` throw `GitSyncNotImplementedError` per Q-NEW-F04E-2 lock. Two-commit composition (Q-NEW-F04E-5): `feat(F04-E)` for the slice surface + `feat(F04)` for module-close summary + status flip.

## Sub-decision locks (HOLD #1)

Two Q-NEW-F04E items were pre-defined in module scope §3 (E-1 / E-2); four new items (E-3 through E-6) emerged at HOLD #1 to cover library choice deferral, status.md flip mechanics, module-close commit shape, and gate-evidence shape. Module-scope canonical numbering preserved.

| ID               | Lock                                                                               | Rationale                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-F04E-1** | YAML schema for round-trip DEFERRED to Phase 2                                     | Build-prompt §F04 §4: "Stub the API; actual Git sync is Phase 2." Lossless YAML (parent_version_id + schema_version + validation_state) vs human-friendly (key-value-only) is a Phase 2 design discussion driven by first consumer's needs.                                                                                                                                                       |
| **Q-NEW-F04E-2** | Stubs THROW `GitSyncNotImplementedError` (dedicated class for type-narrowing)      | Silent no-op would mask the deferral and create enterprise-customer surprise ("Git sync silently did nothing"). Dedicated class lets Phase 2 wrappers `instanceof`-check to surface a polished UX. Error message references roadmap §5.5 + build-prompt §F04 §4 for context.                                                                                                                      |
| **Q-NEW-F04E-3** | Git library choice DEFERRED to first Phase 2 consumer                              | Pinning `simple-git` / `isomorphic-git` / native execSync now commits to a future implementation choice prematurely. Stub does no I/O. First consumer drives the choice (matches ADR-DB-001 deferral pattern).                                                                                                                                                                                    |
| **Q-NEW-F04E-4** | Single-row flip on `docs/progress/status.md` for `P1.4 F04 Configuration Plane`    | Don't retrofit per-slice rows. F04 has tracked as a single row throughout A → D; the asymmetry with F03 (per-slice rows because Slice D is deferred) is accepted. F04's fully-closed state is sufficiently captured by the parent row's ✓. Q-NEW-F04-2's per-slice-rows recommendation was non-binding and never landed.                                                                          |
| **Q-NEW-F04E-5** | Two-commit composition: `feat(F04-E)` slice + `feat(F04)` module-close             | Sets precedent for all future module-close commits in the codebase. Slice E has its own slice-shape work (stub + tests + scope doc); module-close commit is symbolic + reflective (links to all 5 slices, build-prompt acceptance summary, downstream queue). F02 didn't land its module-close commit so F04 establishes the pattern.                                                             |
| **Q-NEW-F04E-6** | Full F03-Slice-B-style gate evidence at `docs/planning/f04-gate-evidence.md` (NEW) | Module close is a meaningful symbolic moment; gate evidence captures it durably. Sections: build-prompt acceptance × evidence; D1-D14 module locks honored across all 5 slices; Q-NEW-F04E-1..6 lock summary; per-slice phase summary; cross-feature impact; PASS-by-construction note for the sub-10ms p99 acceptance criterion (Map.get is O(1); explicit microbenchmark is roadmap candidate). |

## Build plan (E.1 - E.5)

| Step      | Scope                                                                                                                                    | Estimate | Actual                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| **E.1**   | `git-sync.ts` stub — `exportToYaml`, `importFromYaml`, `GitSyncNotImplementedError`, `GitSyncContext`                                    | 0.5 hr   | 0.4 hr                                            |
| **E.2**   | Barrel exports + header doc reflects Slice E shipped + module CLOSED                                                                     | 0.25 hr  | 0.2 hr                                            |
| **E.3**   | `test/git-sync.spec.ts` — 4 specs (throw-shape × 2 fns + error name attribute + barrel-shape)                                            | 0.25 hr  | 0.25 hr                                           |
| **E.4**   | Populate `docs/planning/f04-slice-E-scope.md` from shell                                                                                 | 0.5 hr   | 0.5 hr                                            |
| **E.5**   | Module wrap-up — status.md flip + `f04-gate-evidence.md` + roadmap §5.5 backref + CLAUDE.md `### Git sync stub` + `### F04 module close` | 1.25 hr  | (pending)                                         |
| **Total** |                                                                                                                                          | 2.75 hr  | ~1.35 hr through E.4; total ~2.5-2.75 hr expected |

## Acceptance — module-scope §2 Slice E deliverables

- ✓ `packages/config-plane/src/git-sync.ts` — `exportToYaml(ctx)` + `importFromYaml(ctx, yaml)` stubs throwing `GitSyncNotImplementedError` with Phase 2 + roadmap §5.5 + build-prompt §F04 §4 references in the error message.
- ⏳ Module-close commit `feat(F04): configuration plane` lands per build-prompt template (Commit 2 of two-commit composition per Q-NEW-F04E-5 lock; pending HOLD #3 staging).
- ⏳ F04 status.md row flipped ✓ (single-row pattern per Q-NEW-F04E-4 lock; E.5).
- ⏳ `docs/planning/f04-gate-evidence.md` created per Q-NEW-F04E-6 lock — full gate-evidence shape (E.5).
- ⏳ Roadmap §5.5 cross-reference back to Slice E's stub commit (E.5).
- ✓ All 121 config-plane tests green serially (`--no-file-parallelism`); 4 new Slice E specs + 117 pre-Slice-E tests.

## File surface enumeration

**New files:**

- `packages/config-plane/src/git-sync.ts` (~95 lines — header doc + class + 2 stubs + JSDoc per fn)
- `packages/config-plane/test/git-sync.spec.ts` (~50 lines — 4 specs)
- `docs/planning/f04-slice-E-scope.md` (this file; ~165 lines populated)
- `docs/planning/f04-gate-evidence.md` (E.5; new)

**Modified files (slice + module-close split per Q-NEW-F04E-5):**

Commit 1 (`feat(F04-E)`):

- `packages/config-plane/src/git-sync.ts` (new)
- `packages/config-plane/src/index.ts` (Slice E barrel additions; header doc reflects Slice E + module CLOSED)
- `packages/config-plane/test/git-sync.spec.ts` (new)
- `docs/planning/f04-slice-E-scope.md` (populated from shell)

Commit 2 (`feat(F04)`):

- `docs/planning/f04-gate-evidence.md` (new)
- `docs/progress/status.md` (P1.4 F04 row flipped ✓)
- `docs/future-roadmap.md` (§5.5 cross-reference back to Slice E commit)
- `CLAUDE.md` (`### Git sync stub (Slice E)` subsection + `### F04 module close` note)

## Module-close significance

**F04 = first F-module fully closed in the platform's lineage.** Day's lineage hits 10+ PRs (depending on two-commit vs single-PR resolution). Downstream queue (P1.5 F05 Schema Evolution, P1.6 Feature Flags, D04 quality rules, UX01 theme tokens, IC01 vertical-package selection, IC02 i18n, AC02 hierarchy schema, PR06 retention policies) becomes operator-selectable post-merge.

**Named first consumer:** `@cortex/feature-flags` per module-scope D6 + §4 dependency table line 478. P1.6 ships as a thin layer over F04 — feature flags are stored in `tenant_config_version` rows under a `feature-flags` namespace.

**F03 cross-reference:** F03 module-row stays unchecked even after F04 ✓. F03 Slice C closed inside P1.4 (PR #6); F03 Slice D ("Late-arriving data") remains deferred (blocked by D04 + S01 + SCR-08). F03's full module close lags F04's — readers shouldn't expect F03 ✓ to follow F04 ✓.

## Findings during E.1 - E.5

### E.1 — `@typescript-eslint/require-await` on stub functions

ESLint flagged both stubs with `require-await` (async function with no await). Throwing inside an async function IS a Promise rejection, so the lint is style-only. Two paths considered:

1. Drop `async`, throw synchronously (call-shape lossy — non-await callers get a synchronous throw rather than a rejected promise).
2. Add `eslint-disable-next-line @typescript-eslint/require-await` with rationale comment.

Chose (2) — the `async` keyword pins the Phase 2 contract (Phase 2 implementations will inevitably await DB or filesystem I/O). The disable comment carries the rationale: "stub pins Phase 2 async contract."

### E.3 — Test count delta is 4 not 2

Operator estimate was 2 specs (throw-shape × 2 fns). Shipped 4 — added `name`-attribute assertion (for type-narrowing in JSON-serialized error contexts) + barrel-shape verification (catches barrel drift at compile time + runtime). Marginal cost; comprehensive coverage of the small surface.

### E.5 — pending HOLD #3

E.5 lands the module-close commit's surface. Surfaces at HOLD #3 for operator review of two-commit composition before staging.

## Cross-refs

- Module scope: `docs/planning/p1.4-f04-configuration-plane-scope.md` (D1-D14 + Q-NEW-F04E-1/2 surface; HOLD #1 added E-3 through E-6)
- Slice A scope: `docs/planning/f04-slice-A-scope.md`
- Slice B scope: `docs/planning/f04-slice-B-scope.md`
- Slice C scope: `docs/planning/f04-slice-C-scope.md`
- Slice D scope: `docs/planning/f04-slice-D-scope.md`
- Module gate evidence: `docs/planning/f04-gate-evidence.md` (E.5 deliverable)
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §F04 (line 1146-1148: stub + Phase 2 deferral; line 1168: module-close commit template)
- Roadmap §5.5: `docs/future-roadmap.md` (Configuration-as-Code Git sync; Phase 2 owner)
- Source: `packages/config-plane/src/git-sync.ts`
- Tests: `packages/config-plane/test/git-sync.spec.ts`
- CLAUDE.md: `### Git sync stub (Slice E)` + `### F04 module close` (E.5 deliverables)

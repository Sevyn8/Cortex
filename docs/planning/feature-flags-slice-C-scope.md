# P1.6 Slice C — Admin UI stub + module wrap-up

> Cross-ref: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice C.
>
> Populated 2026-05-10 at HOLD #3 close. Slice C ships the **Phase 1 Admin UI stub** (vanilla HTML + JS at `packages/feature-flags/admin-stub/index.html`) + **convention doc** (`docs/architecture/feature-flags.md`) + **module wrap-up** (gate evidence + status flip + CLAUDE.md ladder). Closes P1.6 at 3/3 slices on the same day as F04.

## §1 Slice goal

Deliver build-prompt acceptance criteria 2 + 3 (Admin UI stub exists + module-close commit) and consolidate all Phase 1 + Phase 2 documentation. Smallest slice in P1.6 — architectural surface settled by Slices A + B.

Module-close commit shape sets the **non-F-module precedent** for the codebase: build-prompt's literal `feat(feature-flags): feature flag service on F04` honored over `feat(P1.6)` form (analogous to F04 Slice E Q-NEW-F04E-5 lock, but with package-name-as-scope rather than F-module-id).

## §2 Phase plan + actuals

| Phase     | Scope                                                                                                                                                                                 | Estimate | Actual    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| **C.1**   | `packages/feature-flags/admin-stub/index.html` — vanilla HTML+JS; ~80-100 lines (operator estimate); landed at ~270 lines incl. CSS + table-rendering JS                              | 0.25 hr  | 0.4 hr    |
| **C.2**   | `docs/architecture/feature-flags.md` — 8-section convention doc per Q-NEW-FF-C-2; ~150 lines target                                                                                   | 0.5 hr   | 0.5 hr    |
| **C.3**   | `docs/planning/feature-flags-gate-evidence.md` — F03-Slice-B-style table per Q-NEW-FF-C-3; ~110-130 lines target                                                                      | 0.4 hr   | 0.5 hr    |
| **C.4**   | `docs/progress/status.md` — flip P1.6 row to `[x]` with full module-close summary block per Q-NEW-FF-C-4                                                                              | 0.15 hr  | 0.1 hr    |
| **C.5**   | `CLAUDE.md` — `### Feature flags (P1.6)` subsection (~30 lines) + `### P1.6 module close` subsection (~20 lines) + `## Coding conventions` 1-line note (convention-doc naming policy) | 0.25 hr  | 0.3 hr    |
| **C.6**   | `docs/planning/feature-flags-slice-C-scope.md` populate from shell — Q-NEW-FF-C-1..5 locks + actuals + lessons                                                                        | 0.2 hr   | 0.2 hr    |
| **Total** |                                                                                                                                                                                       | ~1.75 hr | **~2 hr** |

Slightly above estimate — admin HTML grew larger than predicted (~270 lines vs ~80-100 estimate) due to inline CSS + persistence + status states + table-rendering JS. Convention doc + gate evidence both landed at the upper end of their target ranges.

## §3 Q-NEW-FF-C locks (final)

| ID               | Lock                                                                                                                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-FF-C-1** | (d) `packages/feature-flags/admin-stub/index.html` (vanilla HTML + JS; no React, no bundler)                                 | Honors module-scope prediction at PR #13. SCR-04 ships full admin UI with React + bundler + mutation routes in Phase 2; this stub is throwaway by design. localStorage persistence + base URL + tenant id + userId inputs + Refresh button.                                                                                                                                                                                                         |
| **Q-NEW-FF-C-2** | 8-section convention doc at `docs/architecture/feature-flags.md` (literal name per build-prompt §P1.6 line 1229)             | Filename deviation from `<concept>-convention.md` workspace pattern (`audit-event-convention.md`, etc.) — build-prompt directive wins per CLAUDE.md `## Coding conventions` policy added in C.5. Sections: §1 what they are, §2 lifecycle (3 states + 6-month renewal), §3 server APIs, §4 client API + React-hook recipe, §5 audit semantics (deviation rationale), §6 adding new flags, §7 Phase 2 deferrals, §8 cross-refs. Landed at 156 lines. |
| **Q-NEW-FF-C-3** | F03-Slice-B-style gate evidence at `docs/planning/feature-flags-gate-evidence.md` mirroring `f04-gate-evidence.md` structure | 7 sections (§6 omitted — no PASS-by-construction note applies for P1.6's 3 criteria; criterion 1 is runtime-verifiable via 16 client.spec.ts polling specs, criterion 2 is filesystem-verifiable, criterion 3 is module-close-symbolic). Landed at ~155 lines.                                                                                                                                                                                      |
| **Q-NEW-FF-C-4** | Single-row flip at `docs/progress/status.md` line 79 with full module-close summary block matching F04's line 77 precedent   | Narrative depth: 3 slices ✓ + day-of lineage (PRs #13/#14/#15/#16) + test count (68/68 across 2 packages) + gate evidence reference + downstream queue note.                                                                                                                                                                                                                                                                                        |
| **Q-NEW-FF-C-5** | Two-commit composition matching F04 Slice E Q-NEW-F04E-5 precedent                                                           | Commit 1 `feat(feature-flags-c): admin UI stub + module wrap-up` (slice work + scope doc populate); Commit 2 `feat(feature-flags): feature flag service on F04` (gate evidence + status flip + CLAUDE.md additions). Sets non-F-module module-close commit precedent — package-name-as-scope (`feature-flags`) rather than module-id (`F04`).                                                                                                       |

## §4 File surface

**New files:**

- `packages/feature-flags/admin-stub/index.html` (~270 lines — HTML + inline CSS + vanilla JS).
- `docs/architecture/feature-flags.md` (~156 lines — 8-section convention doc).
- `docs/planning/feature-flags-gate-evidence.md` (~155 lines — module gate evidence).

**Modified files:**

- `docs/progress/status.md` line 79 — P1.6 row flipped `[x]` with full module-close summary block.
- `CLAUDE.md` — `### Feature flags (P1.6)` subsection + `### P1.6 module close` subsection (under `## Configuration plane (F04)` ladder; landed AFTER `### F04 module close` and BEFORE `## SCD policies (F03 Slice C)`); `## Coding conventions` 1-line note for convention-doc naming policy.
- `docs/planning/feature-flags-slice-C-scope.md` — this file populated from shell.

**No code changes** — Slice C ships docs + static HTML + status flip. Test inventory at module close remains 68/68 (no Slice C delta).

## §5 Lessons during build

### Module-scope prediction honored over operator's HOLD #1 alternatives

Operator's HOLD #1 surfaced 3 admin-stub-location options ((a) `apps/feature-flags-api/public/`, (b) `apps/admin-console/`, (c) standalone package). The existing module-scope prediction at PR #13 — `packages/feature-flags/admin-stub/index.html` — wasn't in the surfaced options. HOLD #1 investigation surfaced (d) as the existing prediction; operator confirmed (d). **Pattern note:** when operator surfaces options that don't include the existing scope-doc prediction, surface the prediction explicitly during HOLD #1 so the operator can decide between honoring it or overriding deliberately.

### `apps/admin-console/` deferred to SCR-04 ship

Empty placeholder dir (`.gitkeep` only since 2026-04-20). Slice C does NOT populate it. SCR-04 (Phase 2) rebuilds the admin UI from scratch with React + bundler + mutation routes; the directory stays empty until SCR-04 ships. P1.6 Slice C's static HTML stub is throwaway by design.

### First static HTML asset in workspace; `index.html` naming

Slice C ships the **first non-test, non-build-output HTML file** in the workspace. Naming convention set: `index.html` (matches typical static-site convention). Future workspace HTML assets (SCR-04, possibly D04 admin) should follow.

### Convention doc naming deviation (build-prompt literal honored)

Build-prompt §P1.6 line 1229 specifies `docs/architecture/feature-flags.md` literal — not `feature-flags-convention.md` matching the workspace `<concept>-convention.md` pattern. Build-prompt directive wins. Codified in CLAUDE.md `## Coding conventions` (1-line note added in C.5): "Convention doc naming follows the build-prompt directive when explicit (e.g., `feature-flags.md` per §P1.6 line 1229); falls back to `<concept>-convention.md` workspace pattern otherwise."

### Module-close commit precedent for non-F-modules

P1.6 establishes the **non-F-module module-close commit shape**: `feat(<package-name>): <description per build-prompt>`. Compared to F04's `feat(F04): configuration plane`, P1.6's `feat(feature-flags): feature flag service on F04` uses package-name-as-scope. Future P-prefix modules (P0.8 MCP scaffolding when it ships) follow this pattern; F-prefix modules use F-module-id-as-scope per F04 Slice E precedent.

## §6 Cross-references

- Module scope: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice C + §3 (D5 audit deviation, D8 Phase 2 boundary).
- Convention doc: `docs/architecture/feature-flags.md` (Slice C deliverable).
- Gate evidence: `docs/planning/feature-flags-gate-evidence.md` (Slice C deliverable).
- F04 Slice E precedents:
  - `docs/planning/f04-slice-E-scope.md` Q-NEW-F04E-1 (stub-only deferral pattern); Q-NEW-F04E-4 (single-row status flip); Q-NEW-F04E-5 (two-commit composition); Q-NEW-F04E-6 (gate evidence shape).
  - `docs/planning/f04-gate-evidence.md` (structural template for `feature-flags-gate-evidence.md`).
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.6 lines 1227 (admin UI stub directive), 1229 (convention doc directive), 1245-1246 (acceptance criteria 2 + 3).
- CLAUDE.md additions: `### Feature flags (P1.6)` + `### P1.6 module close` + `## Coding conventions` convention-doc-naming policy note.

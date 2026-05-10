# P1.6 Slice C — Admin UI stub + module wrap-up

> Cross-ref: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice C.
>
> **Populated at slice kickoff (HOLD #1).** This file is a placeholder created during P1.6 module-scoping so the per-slice scope-doc convention is in place when Slice C starts.

## §1 Slice goal

Ship the Admin UI stub (minimal static HTML) + populate the convention doc + close the P1.6 module per build-prompt template.

This is the smallest slice — analogous to F04 Slice E (~2.75 hr) and F05 Slice D (3-5 hr). Stubs + docs + module-close commit.

## §2 Phase plan

Populated at slice HOLD #1. Anticipated phases:

- **C.1** — Admin UI stub (`packages/feature-flags/admin-stub/index.html`) — minimal static HTML listing flags + their states; no interactivity.
- **C.2** — `docs/architecture/feature-flags.md` — full convention doc: lifecycle (`experimental → stable → retired`); 6-month renewal rule; audit deviation rationale (per D5).
- **C.3** — `docs/planning/feature-flags-gate-evidence.md` — F03-Slice-B-style table per F04 Slice E + F05 Slice D precedent.
- **C.4** — `docs/progress/status.md` — P1.6 row flipped ✓ with full module-close summary.
- **C.5** — `CLAUDE.md` — `### Feature flags (P1.6)` subsection covering the package surface + workspace-wide flag-rollout rule.
- **C.6** — Module-close commit `feat(feature-flags): feature flag service on F04` per build-prompt template.

## §3 Q-NEW recommendations (pre-defined from module-scope §4)

- **Q-NEW-FF-C-1** — Admin UI stub shape. **Recommendation:** minimal static HTML in `packages/feature-flags/admin-stub/index.html` listing flags + their current values; NO interactivity Phase 1 (SCR-04 ships full UI with mutations). Lock at HOLD #1.

Additional Q-NEW items may surface during HOLD #1 — likely:

- Module-close commit shape (single-commit vs two-commit composition à la F04 Q-NEW-F04E-5). Lean: **single-commit** for P1.6 because the slice is small + module is non-F-shaped (no build-prompt directive separating slice + module-close).
- Gate-evidence shape (full F03-Slice-B-style table per F04 Q-NEW-F04E-6 precedent).

## §4 File surface anticipated

**Single-commit composition (lean):**

- `packages/feature-flags/admin-stub/index.html` (NEW) — minimal Admin UI stub.
- `docs/architecture/feature-flags.md` (NEW; or completed from Slice B's partial draft) — full convention doc.
- `docs/planning/feature-flags-gate-evidence.md` (NEW) — module-close gate evidence.
- `docs/progress/status.md` — P1.6 row flipped ✓ with full module-close summary.
- `CLAUDE.md` — `### Feature flags (P1.6)` subsection.

**Two-commit alternative** (if operator picks it at HOLD #1):

- Commit 1 `feat(feature-flags-c): admin UI stub + convention doc` (slice work).
- Commit 2 `feat(feature-flags): feature flag service on F04` (module-close summary; per build-prompt directive).

## §5 Effort estimate

1-2 hr per module-scope §6. Smallest of P1.6's slices; mostly stubs + docs + module-close.

## §6 Locks

Populated at slice HOLD #1.

## §7 Lessons

Populated at slice close.

## §8 Cross-references

- Module scope: `docs/planning/p1.6-feature-flags-scope.md` §2 + §3 (D5 audit deviation rationale; D8 Phase 2 boundary; module-close commit-scope convention).
- F04 Slice E precedents: `docs/planning/f04-slice-E-scope.md` (stub-shape Q-NEW-F04E-2; two-commit composition Q-NEW-F04E-5; gate-evidence Q-NEW-F04E-6; status.md single-row Q-NEW-F04E-4).
- F05 Slice D precedent: `docs/planning/f05-slice-D-scope.md` (analogous module-wrap-up shape).
- Build-prompt convention directive: `docs/build-prompts/cortex_build_prompts_v3.md` line 1229 (`docs/architecture/feature-flags.md` lifecycle conventions).
- Build-prompt module-close commit template: line 1246 — `feat(feature-flags): feature flag service on F04`.

# F05 Slice D — A01 stub + AC01 stub + module wrap-up

> Cross-ref: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 Slice D.
>
> **Populated at slice kickoff (HOLD #1).** This file is a placeholder created during F05 module-scoping so the per-slice scope-doc convention is in place when Slice D starts.

## §1 Slice goal

Ship the two Phase-2-deferred stubs (A01 Feature Store hook per D8, AC01 Super Admin approval per D7) and close F05 module per Q-NEW-F04E-5 two-commit precedent (`feat(F05-D)` slice + `feat(F05): schema evolution engine` module-close).

This is the smallest slice — analogous to F04 Slice E (~2.75 hr).

## §2 Phase plan

Populated at slice HOLD #1. Anticipated phases:

- **D.1** — A01 stub (`feature-store-hook.ts`) — `notifyFeatureStore(ctx, schemaChange)` throws `FeatureStoreNotImplementedError` per D8.
- **D.2** — AC01 stub (`access-control-hook.ts`) — `assertCanPromoteBreaking(ctx, env)` env-aware throw per D7.
- **D.3** — Tests for both stubs (assert throw shape; env-aware behavior).
- **D.4** — Module wrap-up: `f05-gate-evidence.md` (NEW), `status.md` flip ✓, CLAUDE.md `### Schema evolution (F05)` ladder, roadmap §4.7 backref to F05 stub commit.
- **D.5** — Two-commit composition stage (Q-NEW-F04E-5 precedent): `feat(F05-D)` + `feat(F05): schema evolution engine` module-close commit.

## §3 Q-NEW recommendations (pre-defined from module-scope §4)

- **Q-NEW-F05D-1** — AC01 stub package location: in `@cortex/access-control-interface` (NEW package created early as F05's stub) vs in `@cortex/schema-evolution` directly. **Recommendation:** in `@cortex/schema-evolution/src/access-control-hook.ts` for Phase 1; extract to `@cortex/access-control-interface` when AC01 ships in P2.1 and the surface stabilizes. Lock at HOLD #1.

Additional Q-NEW items may surface during HOLD #1 — likely:

- Module-close commit subject precedent (F04 Slice E established `feat(F04): configuration plane`; F05 follows pattern with `feat(F05): schema evolution engine`).
- Gate-evidence shape (full F03-Slice-B-style table per F04 Q-NEW-F04E-6 precedent).
- Status.md flip mechanics (single-row per Q-NEW-F04E-4 precedent).

## §4 File surface anticipated

**Commit 1 (`feat(F05-D)`):**

- `packages/schema-evolution/src/feature-store-hook.ts` (NEW) — `notifyFeatureStore` + `FeatureStoreNotImplementedError`.
- `packages/schema-evolution/src/access-control-hook.ts` (NEW) — `assertCanPromoteBreaking` + `SuperAdminApprovalRequiredError`.
- `packages/schema-evolution/src/index.ts` — barrel additions for both stubs + types.
- `packages/schema-evolution/test/{feature-store-hook,access-control-hook}.spec.ts` (NEW).
- `docs/planning/f05-slice-D-scope.md` — populated from shell.

**Commit 2 (`feat(F05): schema evolution engine`):**

- `docs/planning/f05-gate-evidence.md` (NEW) — module-close gate evidence per Q-NEW-F04E-6 precedent.
- `docs/progress/status.md` — P1.5 row flipped ✓ with full module-close summary.
- `docs/future-roadmap.md` — §4.7 cross-reference back to F05 D8 stub commit.
- `CLAUDE.md` — `### Schema evolution (F05)` ladder of subsections + `### F05 module close` note.

## §5 Effort estimate

3-5 hr per module-scope §6. Smallest slice; mostly stubs + docs.

## §6 Locks

Populated at slice HOLD #1.

## §7 Lessons

Populated at slice close.

## §8 Cross-references

- Module scope: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 + §3 (D7 env-aware AC01 stub, D8 throw NotImplementedError for A01 stub, D12 Phase 2 boundary explicit).
- F04 Slice E precedents: `docs/planning/f04-slice-E-scope.md` (stub-shape Q-NEW-F04E-2; two-commit composition Q-NEW-F04E-5; gate-evidence Q-NEW-F04E-6; status.md single-row Q-NEW-F04E-4).
- Roadmap §4.7 (F05 → A01 Feature Store integration hook; D8 stub references).
- Roadmap §1.17 (access control module discipline; D7 stub aligned with AC01's eventual module-disciplined boundary).
- Build-prompt module-close commit template line 1205: `feat(F05): schema evolution engine`.

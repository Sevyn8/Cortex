# F05 Slice C — CI check + classification declarations

> Cross-ref: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 Slice C.
>
> **Populated at slice kickoff (HOLD #1).** This file is a placeholder created during F05 module-scoping so the per-slice scope-doc convention is in place when Slice C starts.

## §1 Slice goal

Ship the migration classification declaration syntax (D5: `-- @schema-classification: ADDITIVE | BREAKING | DEPRECATION` header comment) + two-layer CI enforcement (D6: GHA pre-merge + Cloud Build pre-deploy defense-in-depth).

Acceptance criterion 1 (additive deploys without approval in dev) PASSes via the classifier + Cloud Build path. Acceptance criterion 2 (breaking blocked in non-dev without approval) PASSes via the classifier + Cloud Build path + D7 stub from Slice D (full enforcement Phase 2).

## §2 Phase plan

Populated at slice HOLD #1. Anticipated phases:

- **C.1** — Classification parser (`scripts/check-schema-classification.ts` — parses migration files for `-- @schema-classification:` header).
- **C.2** — GHA workflow integration (`.github/workflows/ci.yaml` extension OR new file).
- **C.3** — Cloud Build pre-deploy verification (`infra/cloud-build/migrate.yaml` step extension).
- **C.4** — Test fixtures: synthetic migration files exercising each classification.
- **C.5** — Classification retrofit on existing 17 migrations.

## §3 Q-NEW recommendations (pre-defined from module-scope §4)

- **Q-NEW-F05C-1** — CI parser location: TS script in `/scripts/` vs Go binary. **Recommendation: TS script.** Workspace already TS-shaped. Lock at HOLD #1.
- **Q-NEW-F05C-2 (likely surfaces at HOLD #1)** — retrofit policy for existing 17 migrations. Backfill all to `ADDITIVE` (most are; some F03/F04 substrate reshapes were BREAKING-without-approval since CI didn't exist). Decide at HOLD #1: retrofit-all vs only-future-migrations vs case-by-case.

Additional Q-NEW items may surface during HOLD #1.

## §4 File surface anticipated

- `scripts/check-schema-classification.ts` (NEW) — parser + CI runner.
- `.github/workflows/ci.yaml` — extension OR `.github/workflows/schema-classification-check.yaml` (NEW).
- `infra/cloud-build/migrate.yaml` — pre-deploy step extension.
- Existing 17 migrations in `services/foundation/migrations/` — header backfill per Q-NEW-F05C-2 lock.
- `services/foundation/migrations/test-fixtures/0099_test_*.sql` (NEW) — synthetic fixtures.
- `scripts/test-classification-parser.spec.ts` (NEW) — parser unit tests.

## §5 Effort estimate

4-6 hr per module-scope §6. Smallest of substrate slices; mostly tooling + retrofit.

## §6 Locks

Populated at slice HOLD #1.

## §7 Lessons

Populated at slice close.

## §8 Cross-references

- Module scope: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 + §3 (D5 header-comment syntax, D6 dual enforcement, D7 stub for non-dev block).
- F03 `-- @bi-temporal: skip` precedent: CLAUDE.md `### Bi-temporal table convention`.
- ADR-CI-001 (Cloud Build migration runner) — second enforcement layer integrates here.
- `.github/workflows/ci.yaml` (existing) — first enforcement layer extends this.
- Build-prompt acceptance criteria 1 + 2.

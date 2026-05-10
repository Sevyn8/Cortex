# F05 Slice A — Substrate + classifier engine

> Cross-ref: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 Slice A.
>
> **Populated at slice kickoff (HOLD #1).** This file is a placeholder created during F05 module-scoping so the per-slice scope-doc convention is in place when Slice A starts.

## §1 Slice goal

Land the bi-temporal `schema_definition` substrate (D1) on F03's `cortex_scd_trigger` foundation, plus the classifier engine (D4 reusing F04 Slice D's `diffJson`), plus the `@cortex/schema-evolution` workspace package skeleton with module discipline per D11 + future-roadmap §1.17.

Slice A unblocks Slice B (versioning + history API needs the substrate) and Slice C (CI check needs the classifier).

## §2 Phase plan

Populated at slice HOLD #1. Anticipated phases:

- **A.1** — Migration 0018 + Drizzle schema entry for `schema_definition` table.
- **A.2** — `@cortex/schema-evolution` package skeleton (`package.json`, `tsconfig.json`, `tsconfig.build.json`, lint/test config).
- **A.3** — Substrate read/write helpers (`substrate.ts`).
- **A.4** — Classifier engine (`classifier.ts` + `diff-extension.ts`).
- **A.5** — Audit catalog (`audit-actions.ts` — 5 verbs per D9).
- **A.6** — Tests + workspace regression.

## §3 Q-NEW recommendations (pre-defined from module-scope §4)

- **Q-NEW-F05A-1** — substrate column layout. Decide between `definition_drizzle_json` + `definition_zod_json` separate columns vs single `definition_json` with discriminator. Lock at HOLD #1.
- **Q-NEW-F05A-2** — classifier algorithm: rule-based vs ML. **Recommendation: rule-based for Phase 1.** Lock at HOLD #1.

Additional Q-NEW items may surface during HOLD #1.

## §4 File surface anticipated

- `services/foundation/migrations/0018_f05_schema_definition.sql` (NEW) — bi-temporal table per D1.
- `packages/canonical-schema/src/drizzle/schema.ts` — `schemaDefinition` pgTable entry.
- `packages/schema-evolution/package.json` (NEW)
- `packages/schema-evolution/tsconfig.json` + `tsconfig.build.json` (NEW)
- `packages/schema-evolution/src/substrate.ts` (NEW) — RLS-bound read/write helpers.
- `packages/schema-evolution/src/classifier.ts` (NEW) — `classifySchemaChange(before, after) → 'ADDITIVE' | 'BREAKING' | 'DEPRECATION'`.
- `packages/schema-evolution/src/diff-extension.ts` (NEW) — extends F04 Slice D's `diffJson` with schema-aware classification.
- `packages/schema-evolution/src/audit-actions.ts` (NEW) — 5 verbs registered.
- `packages/schema-evolution/src/index.ts` (NEW) — barrel.
- `packages/schema-evolution/test/{classifier,substrate}.spec.ts` (NEW).

## §5 Effort estimate

8-12 hr per module-scope §6. Largest slice — substrate + classifier + new package shape.

## §6 Locks

Populated at slice HOLD #1.

## §7 Lessons

Populated at slice close.

## §8 Cross-references

- Module scope: `docs/planning/p1.5-f05-schema-evolution-scope.md` §2 + §3 (D1 bi-temporal, D3 proxy entities, D4 reuse-and-extend, D9 audit verbs, D10 test harness, D11 module discipline).
- F04 Slice D `diffJson` (the primitive Slice A extends): `packages/config-plane/src/impact-analysis.ts`.
- F03 bi-temporal substrate: ADR-DB-001 + `services/foundation/migrations/0002_bi_temporal_helpers.sql`.
- CLAUDE.md `### Bi-temporal table convention` (recipe Slice A migration follows).
- Roadmap §1.17 (access control module discipline — D11 informed by this).

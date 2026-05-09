# F03 Slice C — SCD policy configuration (all 5 types)

> Cross-ref: `docs/planning/f03-temporal-data-engine-scope.md` §Slice-by-slice plan.
>
> Populated 2026-05-09 at HOLD #4 close. Slice C ships the SCD-policy-aware trigger rewrite + per-type implementations for all 5 SCD types (1, 2, 3, 4, 6). Lands within P1.4 phase per F04 D7 cross-feature unblock — F04 Slice B (lifecycle) shipped in PR #5; Slice C consumes `createDraft / validateDraft / promoteDraft` to manage SCD policy changes safely.
>
> Slice C is the first F03 slice to ship in P1.4 (post-P1.3-partial close at Slice A + B + B.5).

## Sub-decision locks

### HOLD #1 (kickoff)

| ID               | Lock                                                                         | Rationale                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-F03C-1** | Option I (full Slice C — all 5 SCD types)                                    | Full module-scope-doc commitment; reduced-scope option (II) explicitly considered + rejected at HOLD #1                                               |
| **Q-NEW-F03C-2** | `tenant.scd` namespace; per-tenant only; hardcoded Type 2 default in trigger | F04 D14 substrate is per-tenant only; no cross-tenant slot exists for `platform.scd`. Forward-compat exit criterion (NULL tenant_id support) recorded |
| **Q-NEW-F03C-3** | Inline policy read in trigger; no caching                                    | Cheap B-tree lookup on `(tenant_id, namespace, version_number)` UNIQUE; caching deferred per same logic as roadmap §1.12                              |
| **Q-NEW-F03C-4** | Default-when-absent = Type 2                                                 | Mandatory backward compat with existing tables (audit_event etc.) using `cortex_scd_trigger` today                                                    |
| **Q-NEW-F03C-5** | Zod schema in `@cortex/temporal-query`                                       | F03's policy schemas in F03's package; consumers of temporal-query already import F03 types                                                           |
| **Q-NEW-F03C-6** | Rely on F04's `CONFIG_VERSION_PROMOTED` audit verb; no F03-specific verbs    | Same coexistence pattern as Q-NEW-F04A-10 — SCD-specific consumers filter by `namespace = 'tenant.scd'` on the audit row                              |

### HOLD #2 (mid-build, between C.2 trigger rewrite and C.3 per-type implementations)

| ID                                                | Lock                                                                                                          | Rationale                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-F03C-7a** (Type 3 schema)                 | Single `previousValueColumn` (canonical SCD Type 3)                                                           | Multi-column previous-value-only deferred as hypothetical Type 7; flagged in CLAUDE.md future-notes                                |
| **Q-NEW-F03C-7b** (Type 4 history-table creation) | (a) caller's migration creates history table; trigger raises clean error if missing                           | Future enhancement: F04 validateDraft hook to check `information_schema.tables` at promote-time; tracked in CLAUDE.md future-notes |
| **Q-NEW-F03C-7c** (Type 6 hybrid)                 | Canonical Type-2 + Type-3 hybrid: row rotation + per-column previous-value capture for `previousValueColumns` | Per-column type specification rejected (structurally incompatible with row-versioning)                                             |
| **Q-NEW-F03C-7d** (Migration path)                | (α) new migration 0017 redefining `cortex.cortex_scd_trigger()`; 0016 stays immutable                         | Standard CREATE OR REPLACE pattern matches 0006's redefine-via-migration precedent                                                 |
| **Q-NEW-F03C-7e** (Schema-version path)           | (γ) in-place v=1 mutation                                                                                     | Safe because zero production drafts pin to v=1 currently. Mutation rule documented in CLAUDE.md `## SCD policies`                  |
| **Q-NEW-F03C-7f** (overrun decision)              | Continue full Option I; multi-session expected                                                                | Original module-scope estimate (6-10 hr) held; HOLD #2's revised 13-14 hr estimate proved conservative                             |

## Build plan — actual vs estimate

| Step                                                      | Scope                                                                    | Estimate                                                | Actual                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------- |
| **C.1**                                                   | SCD-policy Zod schema + namespace registration (placeholder Types 3/4/6) | 1.5 hr                                                  | ~1.5 hr                               |
| **C.2**                                                   | Migration 0016: trigger rewrite (Types 1+2 implemented; 3/4/6 stubbed)   | 2.5-3.5 hr                                              | ~2 hr                                 |
| **HOLD #2** — surface Types 3/4/6 schema-design proposals | —                                                                        | —                                                       |
| **C.3**                                                   | Schema tightening + Migration 0017 (full Types 3/4/6 implementations)    | ~6-7 hr (HOLD #2 revised)                               | ~2.5 hr                               |
| **HOLD #3** — natural session-break candidate             | —                                                                        | —                                                       |
| **C.4**                                                   | Per-type behavior tests (16 cases)                                       | 2 hr                                                    | ~2 hr                                 |
| **C.5**                                                   | Workspace-wide regression check (per-package serial)                     | 0.5 hr                                                  | ~0.25 hr                              |
| **C.6**                                                   | CLAUDE.md `## SCD policies` subsection + this scope doc                  | 1.5-2 hr                                                | ~1.5 hr                               |
| **Total**                                                 |                                                                          | **6-10 hr (module scope) → 13-14 hr (HOLD #2 revised)** | **~9.75 hr (closer to module scope)** |

## Estimation calibration (lessons for future slices)

HOLD #2 re-estimated total Slice C effort upward from the module-scope range (6-10 hr) to 13-14 hr based on schema-design speculation for Types 3/4/6. Actual effort tracked closer to the original module-scope range (~9.75 hr — within bound). The HOLD #2 conservatism overcorrected.

**Lesson:** when HOLD-N estimates diverge meaningfully (>30%) from module-scope estimates, **anchor on the module-scope number unless concrete implementation surprises have already surfaced** (not just speculation about what implementation might require). Schema-design ambiguity at HOLD #2 felt expensive but resolved cleanly with PL/pgSQL `jsonb_populate_record(NEW, ...)` pattern — 2.5 hr vs the speculated 6-7 hr.

This pattern has now shown up in:

- **F04 Slice A** — came in lower than upper bound (~7 hr actual vs 6-10 hr estimate)
- **F03 Slice C** — HOLD #2 conservatism overcorrected (~9.75 hr actual vs HOLD #2's 13-14 hr revised estimate; module-scope's 6-10 hr was right)

Worth recording as workspace-level estimation discipline. (Mirror reference in CLAUDE.md if a slice-planning section materializes; for now this doc is sufficient.)

## File surface

**Source (3 NEW + 3 modified):**

- `packages/temporal-query/src/scd-policy.ts` (NEW; ~150 lines — Zod schema + namespace registration + tightened locked shapes)
- `packages/temporal-query/src/index.ts` (+10 lines barrel for SCD exports)
- `packages/temporal-query/package.json` (+`@cortex/config-plane` + `zod` deps)
- `services/foundation/migrations/0016_f03_scd_policy_aware_trigger.sql` (NEW; ~140 lines — trigger rewrite, Types 1+2 + stubs for 3/4/6)
- `services/foundation/migrations/0017_f03_scd_types_3_4_6.sql` (NEW; ~220 lines — full Types 3/4/6 implementations)
- `services/foundation/migrations/meta/_journal.json` (+2 entries)

**Tests (2 NEW + 1 modified):**

- `packages/temporal-query/test/scd-policy.spec.ts` (NEW; ~150 lines — 19 schema validation tests)
- `services/foundation/test/scd-policy-trigger.spec.ts` (NEW; ~700 lines — 16 trigger behavior tests covering all 5 types + default fallback + F04 lifecycle integration)
- `services/foundation/package.json` (+`@cortex/audit-events` + `@cortex/config-plane` + `@cortex/temporal-query` + `zod` devDeps)

**Docs (2 modified):**

- `CLAUDE.md` (`## SCD policies (F03 Slice C)` new section — 5-type reference table, namespace convention, anti-pattern note, exception-catch rationale, schema-version mutation rule, future-notes)
- This file (`docs/planning/f03-slice-C-scope.md`) — populated from scratch (no prior shell)

**Lockfile:** `pnpm-lock.yaml` (workspace-dep updates)

## Test count delta

| Package                      | Pre-Slice-C | Post-Slice-C | Delta                                                               |
| ---------------------------- | ----------- | ------------ | ------------------------------------------------------------------- |
| `@cortex/temporal-query`     | 20          | **39**       | **+19** (15 schema + 4 tightened-shape rejection cases)             |
| `@cortex/foundation`         | 68          | **84**       | **+16** (per-type SCD trigger behavior + F04 lifecycle integration) |
| All other workspace packages | (unchanged) | (unchanged)  | regression-stable                                                   |

**Total Slice C net new tests: 35.**

## Forward-compat exit criteria

Three forward-compat paths recorded for future operator decisions, captured here so future maintainers don't re-derive:

1. **Cross-tenant DB-driven default** — F04 substrate work to support NULL `tenant_id` rows OR a separate `platform_config` table + RLS carve-out. Replaces the trigger's hardcoded Type 2 fallback with DB-driven lookup. The Slice C trigger keeps the default-path isolated in a single `COALESCE`; replacement point is clear.

2. **Type 7 (multi-column previous-value-only)** — canonical-vs-practical tension on Type 3 single-column lock. Ship if a first consumer needs multi-column previous-value tracking WITHOUT row history. Currently Type 6 covers the multi-column case but couples to row rotation. First-consumer-driven per ADR-DB-001 deferral pattern.

3. **F04 `validateDraft` Type 4 history-table existence check** — cross-module enhancement: validateDraft inspects `information_schema.tables` for the policy's history-table name; promote fails-fast if missing. Currently the trigger raises on first UPDATE/DELETE. Implementation: F03 Slice C registers a validate-hook with `@cortex/config-plane`; hook called from `validateDraft` for `tenant.scd` namespace drafts.

## Acceptance — module-scope §Slice C deliverables

Per `docs/planning/f03-temporal-data-engine-scope.md` slice-by-slice plan + build-prompt §F03(2):

> SCD Policy Configuration — per entity-type config in F04: SCD Type 1 (overwrite), Type 2 (new row per change), Type 3 (previous value in column), Type 4 (history table), Type 6 (hybrid). Trigger-based automation — depending on configured type, update/insert behaves appropriately.

- ✅ Per-entity-type config in F04 — `tenant.scd` namespace with per-table policy entries (`{ "<table_name>": { "type": N, ... } }`).
- ✅ Trigger-based automation — `cortex.cortex_scd_trigger()` reads policy and dispatches by type.
- ✅ All 5 SCD types implemented + tested (Types 1, 2, 3, 4, 6).
- ✅ Default-when-absent = Type 2 backward compat.

## Cross-feature unblock chain

| Slice           | Status post-this-commit                  |
| --------------- | ---------------------------------------- |
| F03 Slice A     | ✓ closed (P1.3)                          |
| F03 Slice B     | ✓ closed (P1.3 + B.5 follow-up)          |
| **F03 Slice C** | **✓ closed (P1.4; this commit)**         |
| F03 Slice D     | DEFERRED — blocked by D04 + S01 + SCR-08 |

**F03 module-row** stays unchecked per Q-NEW-F03-1 / D4 (per-slice rows; flips ✓ at all-4-slices). Slice D unblocks at D04 + S01 + SCR-08 close (probably Phase 2). F03 currently sits at "P1.4-partial-close" with 3 of 4 slices ✓.

## References

- F03 module scope: `docs/planning/f03-temporal-data-engine-scope.md`
- F04 D7 (cross-feature unblock gate): `docs/planning/p1.4-f04-configuration-plane-scope.md` §1 D7
- F04 D14 (workspace namespace deferral; motivates Q-NEW-F03C-2): `docs/planning/p1.4-f04-configuration-plane-scope.md` §1 D14
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.3 F03 (2) SCD Policy Configuration
- ADR-DB-001 — bi-temporal substrate (SCD trigger origin)
- CLAUDE.md `## SCD policies (F03 Slice C)` (the convention-level summary; this scope doc is the slice-level audit trail)
- Migrations: `services/foundation/migrations/0016_*.sql` + `0017_*.sql`
- Source: `packages/temporal-query/src/scd-policy.ts`
- Tests: `packages/temporal-query/test/scd-policy.spec.ts` + `services/foundation/test/scd-policy-trigger.spec.ts`

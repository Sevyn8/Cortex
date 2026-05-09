# F03 Temporal Data Engine — Scope

**Status:** Scoped 2026-05-09; D-decisions partially locked (the rest land at slice-start HOLDs).
**Build prompt:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.3.
**Spec reference:** Cortex v2.2 §F03 Temporal Data Engine.
**Companion ADRs:** ADR-DB-001 (bi-temporal data model — the primary contract), ADR-DB-002 (RLS), ADR-DB-003 (audit SHA chain), ADR-INFRA-005 (Cloud SQL posture).
**Dependencies:** P1.1 (F01 multi-tenancy substrate), P0.4 Phase B (bi-temporal SQL substrate). Inherits clean.

---

## Context

F03 is the platform's temporal-correctness layer: every tenant-scoped domain entity retains its full valid-time + transaction-time history for audit, time-travel queries, and reproducibility. P0.4 Phase B already shipped the **substrate** — `cortex.at_time_t` predicate, `cortex.cortex_scd_trigger()` SCD Type 2 trigger, GiST/exclusion-constraint conventions, ms-precision normalization. F03 builds the **DX + ergonomics layer** on top: lint rules to catch unintended scope departures, scaffolding so authors don't hand-write the 6-line recipe, a query library for as-of access, and the late-arriving-data flow.

F03 is **the first multi-phase F-feature in the Cortex roadmap.** Two of its four spec-listed scope items are blocked by features that haven't shipped yet (F04 Configuration Plane, D04 Quality Context). P1.3 ships the independent slices (A + B) and explicitly defers C + D to the features that block them. F03-as-a-module remains open until C + D land. See **Multi-phase close timeline** below.

### Substrate from P0.4 Phase B already in place

- `cortex.cortex_scd_trigger()` — SCD Type 2 BEFORE UPDATE / BEFORE DELETE trigger. Tenant-agnostic; opt-in per table. (`services/foundation/migrations/0002_bi_temporal_helpers.sql`)
- `cortex.at_time_t(valid_time, txn_time, ts_valid, ts_txn) → boolean` — composable predicate. `IMMUTABLE PARALLEL SAFE`, inlines at plan time. (Migration 0002.)
- `0001_extensions.sql` — `btree_gist`, `pgvector`, `pgcrypto` enabled.
- `BiTemporalRow<T>` + `TstzRange` interface + parser/serializer in `@cortex/canonical-schema/src/temporal.ts`. zod schema.
- `services/foundation/test/bi-temporal.spec.ts` — acceptance test (insert → update → as-of-prior returns pre-update value).
- Migration `0006_bi_temporal_ms_truncation.sql` — Postgres `now()` consumers wrap in `date_trunc('millisecond', now())` so the temporal-quantum matches JS Date precision (cross-ref ADR-DB-001 §Implementation Notes).
- Per-table recipe documented inline in 0002's header (6-line copy-paste: 2 tstzrange columns + trigger + GiST + exclusion + current-version index).

### Substrate F03 must add

- **Slice A — Bi-temporal authoring DX.** CI lint rule + drizzle-kit migration scaffold + `backfill_bitemporal()` helper + per-table wrapper-recipe automation + CLAUDE.md convention extension. P1.3 deliverable.
- **Slice B — Temporal query library.** `@cortex/temporal-query` package with `asOf / currentState / history / between / diff` as composable functions over `at_time_t`. P1.3 deliverable.
- **Slice C — SCD policy configuration.** Type 1 / 2 / 3 / 4 / 6 per entity-type from F04. **Deferred — blocked by F04.**
- **Slice D — Late-arriving data + grace period + Gold re-mat.** **Deferred — blocked by D04 + S01 + SCR-08.**

---

## Spec drift acknowledgment

Three named drifts between the F03 spec wording and what P0.4 Phase B + ADR-DB-001 actually shipped. These are intentional decisions, not bugs — F03 builds on the shipped reality, not the literal spec.

### Drift 1 — `valid_from / valid_to / txn_from / txn_to` (4 scalars) → `valid_time / txn_time` (2 tstzrange)

The build-prompt's "Every tenant-scoped domain table MUST carry: valid_from, valid_to, txn_from, txn_to (tstzrange-backed)" wording is internally contradictory — 4 scalars OR a tstzrange, not both. **Shipped:** 2 `tstzrange` columns. Range operators (`@>`, `&&`) are the ergonomic path; scalar columns were the rejected Alternative 4. **Reference:** ADR-DB-001 §Decision 1 + Alternative 4 (rejected).

### Drift 2 — Named retrieval funcs `asOf / between / diff / currentState` as platform primitives → `at_time_t` predicate

The spec describes the temporal-query library as named retrieval functions with shape `(table, when) → row`. **Shipped:** a single composable predicate `cortex.at_time_t(...)`. The spec-listed names land as **per-table sugar over the predicate**, not as platform primitives. PL/pgSQL `EXECUTE format(...)` (the only Postgres-native way to do "any-table" retrieval) was rejected — opaque to the planner, loses row typing, non-composable. F03 Slice B exposes the named retrievals as a TS library wrapping `at_time_t`, not as new SQL functions. **Reference:** ADR-DB-001 §Decision 3 + Alternative 5 (rejected).

### Drift 3 — "TypeScript decorator / drizzle-kit plugin that auto-generates migrations" → 6-line copy-paste recipe (Slice A formalizes)

The build prompt expects an "automatic" path (decorator / drizzle-kit plugin) for adding bi-temporal columns. **Currently shipped:** a 6-line SQL recipe documented in `0002_bi_temporal_helpers.sql` header. **Slice A's deliverable** narrows this drift: ships a CI lint rule (PR-blocking) + a drizzle-kit-flavored migration scaffold (operator command produces the recipe-applied SQL) + `backfill_bitemporal()` helper for legacy tables. The "decorator" framing is rejected — drizzle-kit's pgTable definitions are not a place to attach side-effecting macros; the scaffold approach matches workspace conventions. **Reference:** ADR-DB-001 §Implementation Notes ("Migration authors copy a 6-line recipe").

---

## Cross-feature dependency landscape

| F03 spec scope item                                                 | Slice | Blocks (deps)                                                        | P1.3 status               |
| ------------------------------------------------------------------- | ----- | -------------------------------------------------------------------- | ------------------------- |
| (1) Bi-temporal column standard (lint + scaffold + backfill)        | A     | None                                                                 | **Ships P1.3**            |
| (2) SCD policy configuration (Type 1/2/3/4/6 per entity-type)       | C     | F04 (`tenant_config_version` + zod schemas + draft/validate/promote) | **Deferred to F04 close** |
| (3) Temporal query library (`asOf / between / diff / currentState`) | B     | None at library layer                                                | **Ships P1.3**            |
| (4) Late-arriving data (grace, flag, review queue, Gold re-mat)     | D     | D04 (Quality Context) + SCR-08 (review UI) + S01 (Gold pipeline)     | **Deferred to D04 close** |

P1.3 closes F03's **independently-shippable substrate** (A + B). The module remains open until C + D land. Status.md tracks F03 with per-slice rows (Q-NEW-F03-1 below) so the partial-close state is unambiguous.

---

## Multi-phase close timeline

F03 is the first multi-phase F-feature; this section is the canonical reference for when each slice closes + what triggers re-open.

| Slice | Closes when…                                                                                                                                                                                                                     | Re-open trigger                                                                                       | Owner phase                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| **A** | Lint rule on CI; drizzle-kit migration scaffold ships; backfill helper tested; CLAUDE.md convention extension lands                                                                                                              | First domain table that needs the scaffold lifts an issue (refinements arrive lazily)                 | P1.3                              |
| **B** | `@cortex/temporal-query` package exports `asOf / currentState / history / between / diff` over `at_time_t`; acceptance test from spec ("create retail.Product, update price, query as-of-last-week") passes                      | First-consumer-driven additions: tRPC handlers (Q-NEW-F03B-1 defers); SQL views; new query primitives | P1.3                              |
| **C** | F04 ships its config-storage layer + zod-validated schema namespace for SCD policies; F03 Slice C wires per-entity-type config-driven trigger behavior + Type 1/2/3/4/6 plumbing                                                 | F04 close → opens Slice C as the next F03 slice                                                       | Post-F04                          |
| **D** | D04 ships grace-period config + late-arrival flag + manual review queue (SCR-08); S01 ships Gold-layer re-materialization plumbing; F03 Slice D wires `late_arrival_threshold` consumption + flag emission + Gold-re-mat trigger | D04 close (or whichever of D04/SCR-08/S01 lands last) → opens Slice D                                 | Post-D04 + post-S01 + post-SCR-08 |

**F03 module-level close** = all 4 slices ✓. Earliest realistic timeline: post-D04 + post-S01 (probably Phase 2). Until then, F03 sits at "P1.3-partial" with C + D as known-deferred. The status.md row pattern (Q-NEW-F03-1) makes this explicit.

---

## Acceptance criteria

Spec-listed acceptance items + which slice satisfies each:

| Spec acceptance                                                                               | Slice                                                 | P1.3 status                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| 1. "Create retail.Product, update price, query 'as of last week' — returns last week's price" | B (acceptance test in `@cortex/temporal-query` test/) | PASS at P1.3                       |
| 2. "Event arriving 2 hours late (grace = 1 hour) is flagged and appears in review queue"      | D                                                     | DEFERRED — blocked by D04 + SCR-08 |
| 3. "Gold layer KPIs re-materialize correctly when affected windows receive late data"         | D                                                     | DEFERRED — blocked by D04 + S01    |

**P1.3 close evidence:** Slice A gate evidence (CI lint blocks PR; scaffold generates correct SQL) + Slice B gate evidence (acceptance #1 passing). C + D acceptance evidence captured at the future feature's close, NOT F03's.

---

## Decisions (D1-DN — locked at slice HOLDs)

Locked at this scope-doc level (4):

### D1 — Slice structure: 4 slices, 2 ship in P1.3, 2 deferred-by-dependency

A + B independent (P1.3); C blocked by F04; D blocked by D04 + SCR-08 + S01. The dependency landscape table above is authoritative; slice numbering follows alpha order with no skip (matches F02 Slice A/B/C/D precedent).

### D2 — Slice A scope is authoring-DX, not new SQL primitives

Slice A's deliverables are CI lint + drizzle-kit migration scaffold + `backfill_bitemporal()` helper + CLAUDE.md convention extension. **No new SQL functions / triggers ship in Slice A** — those land per-first-consumer per ADR-DB-001 deferral pattern + roadmap §5.1 / §5.2. Rationale: ADR-DB-001 explicitly "deferred to first consumer" (its Decision 8 retrospective) — Slice A respects that.

### D3 — Slice B scope is a TS library; tRPC handlers + SQL views deferred

`@cortex/temporal-query` exports the 5 named functions (`asOf / currentState / history / between / diff`) as composable TS functions wrapping `at_time_t`. **No tRPC handlers, no SQL views in Slice B** — both are first-consumer-driven (Q-NEW-F03B-1 below). Rationale: matches the pattern ADR-DB-001 set; library lands now, surface choice is the consumer's. Compresses Slice B effort 10–14 hr → 4–6 hr.

### D4 — Multi-phase F-feature representation in status.md: per-slice rows (per Q-NEW-F03-1)

Per Q-NEW-F03-1 below: F03 gets per-slice rows (matches Slice D's existing pattern) — `[x] F03 Slice A`, `[x] F03 Slice B`, `[ ] F03 Slice C (deferred — blocked by F04)`, `[ ] F03 Slice D (deferred — blocked by D04+S01+SCR-08)`. F03-as-a-module flips ✓ when all 4 slice rows are ✓. No new symbology (□ binary or ▣ partial were the alternatives — rejected per Q-NEW-F03-1).

Open at this scope-doc level (TBD; lock at slice-start HOLDs):

- D5 — Lint rule scope: how does the lint distinguish "should be bi-temporal" from "bookkeeping / queue / control-plane" tables? Tag-based, schema-based, or exception-list? **Lock at Slice A HOLD #1.**
- D6 — Drizzle-kit scaffold shape: TS-side `pgTable` macro, raw-SQL template, or a generator script? **Lock at Slice A HOLD #1.**
- D7 — `@cortex/temporal-query` package vs. extension of `@cortex/canonical-schema`. Effort + import-graph trade-off. **Lock at Slice B HOLD #1.**
- D8 — `at_time_t` invocation shape from TS: pass `tstzrange` as wire-formatted strings, or expose a `customType` that handles parse/serialize on both sides? Affects the public API of `temporal-query`. **Lock at Slice B HOLD #1.**

---

## Q-NEW-F03-X planning questions (cross-slice)

### Q-NEW-F03-1 — How does status.md represent multi-phase F-features?

**Question:** F03 is the first multi-phase F-feature (F02 closed in one phase across 4 slices, but C + D defer F03 across at least 2 phases). How should status.md represent that?

**Options:**

- (□) **Binary** — a single `[ ] F03 Temporal Data Engine` row that flips to `[x]` only when ALL 4 slices are ✓. Risk: hides P1.3-partial state; reader can't tell what shipped vs deferred.
- (▣) **Partial-checked** — introduce a new `[~]` or `[▣]` symbol for "partial-close". Risk: new symbology; readers + tooling must learn it.
- (per-slice rows, **recommended**) — one row per slice (`[ ] F03 Slice A`, `[ ] F03 Slice B`, etc.), F03-module-row flips ✓ only when all 4 are ✓. Matches the **F02 Slice D pattern** already in use; no new symbology; reader sees exactly what shipped + what's deferred.

**Resolution: per-slice rows.** Locked here as D4 above. Status.md updated in this commit.

### Q-NEW-F03B-1 — Does Slice B include tRPC handlers + SQL views?

**Question:** Spec wording for §F03 (3) Temporal Query Library mentions both library functions AND "exposed via tRPC API for admin screens and via SQL views for analytical screens". Does Slice B build all three layers?

**Options:**

- All-three: ship library + tRPC + SQL views in Slice B. Effort 10–14 hr. Most complete.
- (**recommended**) Library only; defer tRPC + SQL views to first-consumer per ADR-DB-001 deferral pattern. Effort 4–6 hr. Matches the "predicate-now-wrappers-later" precedent. tRPC handler shape is best designed when the first admin screen (likely SCR-04 or SCR-20) actually consumes it; SQL view shape is best designed when the first analytical screen lands. Adding both speculatively risks shapes that don't match consumer needs.

**Resolution: defer tRPC + SQL views per the recommendation.** Locked here as D3 above. Slice B effort revised 10–14 → 4–6 hr in the slice-by-slice plan below.

**Where each lands when first consumer arrives** (so the future session arriving at first-consumer time has a clear pickup, NOT another open question):

- **tRPC handlers → `@cortex/temporal-query` package** as a secondary export entry point (e.g., `@cortex/temporal-query/trpc`). Rationale: tRPC handlers are generic + cross-cutting — they take a `table` argument and dispatch to the same `asOf / currentState / history / between / diff` logic regardless of consumer. Centralizing in the temporal-query package avoids duplicate wrappers across consumers. The secondary-entry-point shape lets consumers that don't need tRPC (e.g., SQL-views consumers) avoid the tRPC dep tree. **First consumer trigger:** the first admin screen consuming temporal data — likely SCR-04 (Tenant Configuration & Theme) or SCR-20 (Audit Log UI).
- **SQL views → per-table at the consuming F-/D-series migration's site** (matches the existing per-table `<t>_as_of_valid` wrapper pattern from roadmap §5.2). Rationale: SQL views are intrinsically per-table — they project specific columns from a specific table; can't be parameterized in a Postgres view. The view lands in the same migration that creates the table (one migration per consuming F-/D-series table). **First consumer trigger:** the first analytical screen needing a current-version SQL view of a specific F-/D-series table.

This split — generic in @cortex/temporal-query, per-table at the table's migration — is binding for the first consumer to pick up. It is NOT a separate open question; if the first-consumer session has reason to deviate, the deviation lands as a Q-NEW-F03B-2 at that time + amends this resolution.

### Q-NEW-F03-2 — When does F03's module-level row flip ✓?

**Question:** With per-slice rows (D4 / Q-NEW-F03-1), the F03 module-level row needs a clear flip rule.

**Options:**

- All-4-slices ✓ (strict). Module flips only at full close — multi-phase + multi-quarter.
- All-shipped-slices ✓ + deferred-slices explicitly tagged (lenient). Module flips at P1.3 close as "F03-P1.3 ✓" with C + D explicitly remaining.

**Resolution: TBD.** Lock at Slice B close (when P1.3-partial F03 close is staring at us). Default expectation: lenient — "F03 P1.3 ✓ (C + D deferred)" — but the wording matters and is best decided when the actual status.md edit happens.

---

## Cleanup vectors (roadmap §5.x items F03 touches)

F03 closes / consumes / cross-references these existing first-consumer-driven roadmap entries:

| Roadmap item                                                                          | F03 disposition                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §5.1 — `as_of_known`, `point_in_time_join`, `temporal_union`, `temporal_intersection` | **Cross-referenced + left open.** Slice B builds the TS library on `at_time_t`; the SQL primitives in §5.1 remain first-consumer-driven (`point_in_time_join` → A01 P4.x; others → first analytical-screen consumer). F03 doesn't close §5.1; it acknowledges the deferral. |
| §5.2 — Per-table `as_of_valid` wrappers                                               | **Cross-referenced + left open.** Slice A's drizzle-kit scaffold may generate the per-table wrapper at table-creation time as a follow-on (Q-NEW-F03A-X at Slice A planning); whether it does is a Slice A SD decision, not a Q-NEW-F03 decision.                           |
| §5.3 — `verify_chain` audit-chain integrity                                           | **Out of scope.** Audit-chain is ADR-DB-003; F03 is bi-temporal data model. Cross-referenced for context only.                                                                                                                                                              |
| §5.4 — `cortex_admin` role + admin-bypass policies                                    | **Out of scope.** Cross-referenced for context only.                                                                                                                                                                                                                        |

No new roadmap entries surface from this scope doc. Slice A planning may add Q-NEW-F03A-X items that land as roadmap entries during Slice A work.

---

## Slice-by-slice plan

| #   | Title                                                                                                                                                                 | Estimate | Ships                             | Dependency       | Status                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------- | ---------------- | ---------------------------------------------------- |
| A   | Bi-temporal authoring DX (CI lint + drizzle-kit scaffold + backfill helper + CLAUDE.md convention)                                                                    | 8–12 hr  | P1.3                              | Inherits clean   | Detailed scope: `docs/planning/f03-slice-A-scope.md` |
| B   | Temporal query library — `@cortex/temporal-query` package: `asOf / currentState / history / between / diff` over `at_time_t` (TS library only; no tRPC; no SQL views) | 4–6 hr   | P1.3                              | A                | Detailed scope at Slice B start                      |
| C   | SCD policy configuration (Type 1/2/3/4/6 per entity-type from F04)                                                                                                    | 6–10 hr  | post-F04                          | F04              | DEFERRED                                             |
| D   | Late-arriving data (grace + flag + review queue + Gold re-mat)                                                                                                        | 12–18 hr | post-D04 + post-S01 + post-SCR-08 | D04, S01, SCR-08 | DEFERRED                                             |

**P1.3 nominal:** 12–18 hours = ~2–3 working days. Cushion at the high end for Slice A's lint-rule shape decision (D5 — non-trivial; tag/schema/exception-list trade-offs) + Slice B's `customType` decision (D8 — affects the public API).

**F03 module nominal (post-deferred):** 30–46 hours total across all 4 slices. Slice C + D land per their feature-dependency triggers; will not be sized further at F03 P1.3 close.

---

## Forcing functions (§10 spec items F03 hits)

(F03 spec section §10 — forcing functions — to enumerate at Slice A start when build prompt context is fresh. Initial scan: F03's forcing functions are smaller-surface than F02's because most of the platform substrate already shipped. Likely 2–4 items: bi-temporal-on-every-tenant-table mandate, ms-precision-quantum guarantee, temporal-query primitive composability lock, ENTERPRISE retention-window override.)

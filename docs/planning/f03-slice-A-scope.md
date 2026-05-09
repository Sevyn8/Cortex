# F03 Slice A — Bi-temporal Authoring DX — Scope

**Status:** Scoped 2026-05-09; SD-decisions partially locked (the rest land at Slice A start HOLD #1; sub-phase decomposition deferred to detailed read of `0002_bi_temporal_helpers.sql` + drizzle-kit setup at slice start, NOT pre-locked here).
**Higher-level scope:** `docs/planning/f03-temporal-data-engine-scope.md` (this is the detailed Slice A plan).
**Build prompt:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.3 scope item (1) "Bi-Temporal Column Standard".
**Spec reference:** Cortex v2.2 §F03 (acceptance items 1 + 3 partially; full coverage at Slice B + Slice D).
**ADRs:** ADR-DB-001 (primary contract), ADR-DB-002 (RLS interaction), ADR-DB-003 (audit chain — informational).
**Dependencies:** P0.4 Phase B (substrate). Inherits clean.

---

## Context

Slice A is the **authoring-DX layer** on top of the bi-temporal substrate that P0.4 Phase B already shipped. It addresses **Drift 3** (per `f03-temporal-data-engine-scope.md`): the F03 spec wording asks for "automatic" bi-temporal column generation; what's currently shipped is a 6-line copy-paste recipe in the `0002_bi_temporal_helpers.sql` header. Slice A formalizes the recipe into:

- A **CI lint rule** that fails any PR adding a tenant-scoped domain table that doesn't follow the recipe (or doesn't explicitly opt out).
- A **drizzle-kit migration scaffold** that operator-invokes to produce the recipe-applied SQL with the correct exclusion / GiST / current-version-index lines.
- A **`backfill_bitemporal()` helper** for legacy tables that exist but lack the columns (currently zero — but the helper future-proofs).
- A **CLAUDE.md "Database conventions" extension** documenting the convention.

No new SQL functions / triggers ship in Slice A. The substrate is whole; this slice is only ergonomics + enforcement.

### Substrate already in place (from P0.4 Phase B — DO NOT modify)

- `cortex.cortex_scd_trigger()` — Migration 0002.
- `cortex.at_time_t(valid_time, txn_time, ts_valid, ts_txn) → boolean` — Migration 0002.
- 6-line per-table recipe in 0002 header (lines 14–49).
- `BiTemporalRow<T>` + `TstzRange` + parser/serializer in `@cortex/canonical-schema/src/temporal.ts`.
- `services/foundation/test/bi-temporal.spec.ts` acceptance test.
- ms-precision normalization in migration 0006.

### Substrate Slice A must add

- Lint rule (CI-runnable; PR-blocking).
- Drizzle-kit migration scaffold (operator command + template).
- `backfill_bitemporal()` SQL helper for legacy tables.
- CLAUDE.md convention extension.

---

## Acceptance criteria

1. **CI lint rule** — A PR that adds a CREATE TABLE statement matching tenant-scoped-domain criteria (D5 below) without `valid_time` + `txn_time` + the trigger + the GiST + the exclusion constraint **fails CI**. Test fixtures: a deliberately-broken migration must produce a failing lint with a clear error pointing at the missing pieces.
2. **Scaffold** — Operator runs `<command-TBD-at-D6>` against a table-name + business-key + tenant-scoped flag and gets a SQL file containing the full recipe-applied DDL: tstzrange columns, trigger attach, GiST index, exclusion constraint, current-version index. Output is operator-edit-able (not auto-applied).
3. **Backfill helper** — `cortex.backfill_bitemporal(table_name)` adds the 2 columns + trigger + indexes + exclusion to an existing table that lacks them. Idempotent (re-running on an already-bi-temporal table is a no-op). Tested against a synthetic legacy-table fixture.
4. **CLAUDE.md** — `## Database conventions` section gains a `### Bi-temporal table convention` subsection documenting: when to use bi-temporal (D5's rule), the recipe, how to invoke the scaffold, when to use the backfill helper, the `ENABLE_TEST_ROUTES`-style escape hatch (D5 again).

---

## Decisions (SD1-SDN — partial lock)

Locked at this scope-doc level (4):

### SD1 — No new SQL primitives in Slice A

Slice A delivers DX + enforcement, not new substrate. `cortex.at_time_t` + `cortex.cortex_scd_trigger` are sufficient; per-table wrappers + `as_of_known` + `point_in_time_join` etc. land first-consumer-driven per ADR-DB-001 + roadmap §5.1 + §5.2. **Rationale:** ADR-DB-001 explicitly defers these. Slice A respects.

### SD2 — Sub-phase decomposition deferred to Slice A start

The 4 deliverables (lint, scaffold, backfill, CLAUDE.md) are the slice's deliverables but the sub-phase ordering + estimates are NOT locked here. Reason: the lint-rule shape (D5) and scaffold shape (D6) are non-trivial decisions that need a detailed read of the existing drizzle-kit setup + the 0002 SQL header before locking. Sub-phase decomposition lands at Slice A start (Task 1 of M1 for Slice A) after that read.

### SD3 — `backfill_bitemporal()` lands as a Postgres function in `cortex` schema, not a TS migration helper

PL/pgSQL `EXECUTE format(...)` for the DDL. Idempotent via `IF NOT EXISTS` checks on column existence. Lives alongside `at_time_t` + `cortex_scd_trigger` in the `cortex` schema. **Rationale:** consistent with where the other bi-temporal infrastructure lives; usable from psql / migration files / drizzle-kit alike; doesn't require a TS-side dependency at the point of legacy-table conversion.

### SD4 — CLAUDE.md "Bi-temporal table convention" subsection extends `## Database conventions`

Lands as a new sub-section under the existing top-level `## Database conventions` (line 144 area of CLAUDE.md). 3-bullet pattern: (a) when to use; (b) the 6-line recipe + scaffold-command pointer; (c) backfill helper for legacy. **Rationale:** matches the F02 D.6-shipped `apps/<workload>-api/` workspace-layout note pattern.

Open at this scope-doc level (lock at Slice A start HOLD #1):

### SD5 — Lint rule scope: HOW does it know "should be bi-temporal"?

Three approaches surface:

| Approach           | How                                                                                                                                                                     | Pros                                               | Cons                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Tag-based**      | Migration files include a `-- @bi-temporal: yes\|no\|skip` directive; lint reads it                                                                                     | Explicit; opt-out is named                         | Authors can forget the tag                                                         |
| **Schema-based**   | Tables in a `cortex.` schema are bookkeeping; `public.` tables are domain (must be bi-temporal); explicit `-- @bi-temporal: skip` for exceptions                        | Schema is a natural domain/control-plane separator | Doesn't fit current layout (control-plane tables ARE in public per migration 0007) |
| **Exception-list** | Default: `tenant_id` column → must be bi-temporal. Allowlist of bookkeeping tables (`tenant_quota_usage`, `tenant_kms_key`, `audit_event`, etc.) hard-coded in the lint | Tight; matches today's reality                     | Allowlist drift; one new bookkeeping table without listing it = false positive     |

**Lock at Slice A HOLD #1.** Recommended (preliminary): **exception-list with named opt-out directive** — best of both worlds (default-on + explicit override).

### SD6 — Scaffold shape: pgTable macro, raw-SQL template, or generator script?

| Approach             | How                                                                                                                                    | Pros                                                                    | Cons                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **TS pgTable macro** | `bitemporalTenantTable(name, columns, businessKey)` in `@cortex/canonical-schema/drizzle` returning a pgTable + side-effect statements | Authors stay in TS; drizzle-kit picks up automatically                  | Side-effect (trigger + exclusion) NOT representable in pgTable; needs raw SQL emit anyway |
| **Raw-SQL template** | Operator runs `make db-scaffold-bitemporal TABLE=foo BUSINESS_KEY=bar` → produces a `.sql` file with the recipe applied                | Honest about being SQL; single source for trigger / exclusion / indexes | New Makefile target; operator must edit the generated file for domain-specific columns    |
| **Generator script** | TS script in `services/foundation/scripts/scaffold-bitemporal.ts` that takes args + emits SQL                                          | Flexible; can lint as it generates                                      | Adds a script; another place for shape decisions to live                                  |

**Lock at Slice A HOLD #1.** Recommended (preliminary): **raw-SQL template via Makefile target** — matches the `make image-bootstrap` / `make tf-plan-dev` pattern; no new TS infrastructure; operator edit-able output.

### SD7 — Time horizon + sub-phase shape

Will the slice break into 3 sub-phases (Lint / Scaffold+Backfill / CLAUDE.md+gate) or 4 sub-phases (Lint / Scaffold / Backfill / Docs+gate)? **Lock at Slice A HOLD #2** (build plan).

---

## Q-NEW-F03A-X planning questions

### Q-NEW-F03A-1 — Should the scaffold also generate per-table `as_of_valid` wrappers (roadmap §5.2)?

**Question:** ADR-DB-001 says per-table `<t>_as_of_valid(entity, ts)` wrappers are 1-line functions over `at_time_t`. Should Slice A's scaffold generate them at table-creation time (avoiding the per-table re-decision) OR leave them strictly first-consumer-driven per roadmap §5.2?

**Options:**

- **Generate-now.** Scaffold emits the wrapper alongside the recipe. Trade-off: builds something that may not be used; complicates the scaffold output.
- **Defer (recommended).** Match roadmap §5.2's "first-consumer-driven" framing strictly. Wrappers land at the same time as the first non-trivial query-site. Trade-off: per-table wrappers re-decided each time.

**Lock at Slice A HOLD #1** alongside SD5/SD6.

### Q-NEW-F03A-2 — Where does the lint rule's hook live in CI?

**Question:** GitHub Actions workflow that runs the lint? Husky pre-commit hook (matching the existing commitlint pattern)? Both?

**Options:**

- **CI workflow only.** Standard practice; doesn't slow local commits.
- **Pre-commit hook only.** Catches earlier; bypassable with `--no-verify`.
- **Both.** Belt + braces.

**Lock at Slice A HOLD #2** (build plan; depends on SD5 outcome).

### Q-NEW-F03A-3 — Lint-rule false-negative tolerance: fail-closed or fail-open on unknown table types?

**Question:** When the lint sees a CREATE TABLE that doesn't match either the bi-temporal pattern OR the bookkeeping allowlist, should it fail (default-on; assume domain) or pass (default-off; assume bookkeeping unless tagged)?

**Options:**

- **Fail-closed (recommended).** New tables MUST opt out explicitly. Forces author intent into review.
- **Fail-open.** Lint only catches tables explicitly tagged as domain. Author can forget the tag → silent miss.

**Lock at Slice A HOLD #1.** Strong preliminary toward fail-closed.

---

## Sub-phase plan

**Note:** Detailed sub-phase decomposition deliberately deferred per **SD2**. Sub-phase rows + estimates lock at Slice A start (Task 1 of Slice A's M1) after detailed read of `0002_bi_temporal_helpers.sql` + drizzle-kit setup + the existing 0007 control-plane-table layout.

Approximate effort breakdown (lock at slice start):

| Phase                  | Surface                                                                                                                | Approx |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| 1 — Lint rule          | Tag/schema/exception-list shape (SD5); fail-closed/open (Q-NEW-F03A-3); CI vs pre-commit (Q-NEW-F03A-2); test fixtures | 3–5 hr |
| 2 — Scaffold           | SD6 shape; Makefile target / generator script; recipe-applied SQL output; smoke-test                                   | 2–3 hr |
| 3 — Backfill           | `cortex.backfill_bitemporal(table_name)` PL/pgSQL function; idempotency + tests                                        | 2–3 hr |
| 4 — Convention + close | CLAUDE.md ## Database conventions extension; gate evidence; squash                                                     | 1–2 hr |

**Slice A nominal:** 8–12 hours (matches f03-temporal-data-engine-scope.md slice-by-slice plan estimate).

---

## Forcing functions (Slice A subset)

(F03 spec §10 forcing-functions roll-up to enumerate at Slice A start. Slice A's relevant subset likely 1–2: bi-temporal-on-every-tenant-table mandate (SD5 codifies); ms-precision-quantum guarantee (carried forward from migration 0006; doc cross-ref in CLAUDE.md extension).)

---

## Acceptance + gate evidence shape

Gate evidence captured in `docs/planning/f03-slice-A-gate-evidence.md` at slice close. Sections:

1. CI lint rule blocks a synthetic broken-migration PR.
2. Scaffold produces correct recipe-applied SQL for a synthetic table.
3. `cortex.backfill_bitemporal()` converts a synthetic legacy table; verified idempotent.
4. CLAUDE.md diff included.
5. Acceptance criteria roll-up (4 from above).

Mirrors the F02 Slice D / D.4 / D.5 / D.4.5 / D.6 gate-evidence shape established in `docs/planning/d{4,4.5,5,6}-gate-evidence.md`.

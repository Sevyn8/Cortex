# ADR-DB-001: Bi-temporal Data Model Implementation

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2.2 Spec §F03 Temporal Data Engine, §F01 §1.4 Data Model; P0.4 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-005 (Cloud SQL posture), ADR-DB-002 (RLS contract), ADR-DB-003 (audit SHA chain)

---

## Context

F03 specifies that core domain entities (tenants, hierarchy, facts) retain their full valid-time and transaction-time history — for audit, time-travel queries, and reproducibility. This is a cross-cutting infrastructure concern: every tenant-scoped domain table follows the same pattern, so helpers and conventions must exist before any F0X table is written.

Phase B locks in:

1. How valid-time and transaction-time are stored.
2. How UPDATE / DELETE preserve prior versions (SCD Type 2).
3. The **composable primitive** for retrieving "as-of" values — not the full retrieval API, which is additive and built per-table when D01 tables land.
4. What indexes every temporal table carries to make these queries tractable.

This ADR defines the infrastructure those tables will stand on — it does not define any D01 tables.

## Decision

**Two `tstzrange` columns, SCD Type 2 via a shared `BEFORE UPDATE / BEFORE DELETE` trigger function, a single composable `at_time_t` predicate, GiST range indexes, per-table exclusion constraints on the business key.**

Specifically:

1. **Two `tstzrange` columns on every temporal table.**
   - `valid_time tstzrange NOT NULL` — when the fact is true in the business world.
   - `txn_time tstzrange NOT NULL DEFAULT tstzrange(now(), NULL)` — when the fact was known to the system. Upper bound `NULL` = currently-known (open range `[now(), ∞)`).
   - No scalar `valid_from` / `valid_to` / `txn_from` / `txn_to` columns. Range operators (`@>`, `&&`) are the ergonomic path.

2. **SCD Type 2 via shared trigger function `cortex.cortex_scd_trigger()`.**
   - `BEFORE UPDATE`: close the current row (`txn_time = tstzrange(lower(txn_time), now())`), then INSERT a new row with the NEW values and `txn_time = tstzrange(now(), NULL)`. Return NULL to cancel the physical UPDATE.
   - `BEFORE DELETE`: close `txn_time` (logical delete, never physical). Return NULL to cancel the physical DELETE.
   - Tables opt in:
     ```sql
     CREATE TRIGGER <name>
       BEFORE UPDATE OR DELETE ON <table>
       FOR EACH ROW EXECUTE FUNCTION cortex.cortex_scd_trigger();
     ```
   - Trigger is tenant-agnostic — RLS is enforced independently (ADR-DB-002).

3. **Query primitive in Phase B (0002 migration): `cortex.at_time_t` only.**
   - `cortex.at_time_t(valid_time tstzrange, txn_time tstzrange, ts_valid timestamptz, ts_txn timestamptz) RETURNS boolean` — true when both ranges contain their respective anchors.
   - Usage: `WHERE cortex.at_time_t(valid_time, txn_time, $asOfBusiness, $asOfSystem)`.
   - `IMMUTABLE PARALLEL SAFE` pure SQL (inlined at plan time).
   - **Per-table convenience wrappers** (`cortex.<table>_as_of_valid`, `cortex.<table>_as_of_latest`, `cortex.<table>_history`) are **not** part of 0002. They are generated per-table when each bi-temporal table is first added (D01 and module migrations), built as thin wrappers around `at_time_t`. The 0002 migration's header comment documents the per-table recipe.
   - **Deferred to first consumer** (per prior-session Decision 8 retrospective): `as_of_known` (system-time view), `point_in_time_join` (A01 Feature Store, P4.x), `temporal_union`, `temporal_intersection`. These are F03-spec-listed and will be **added** when needed, not redesigned — the predicate + trigger in 0002 is the minimum infrastructure; everything else is additive.

4. **Indexing convention (applied per-table, not centrally).**
   - `CREATE INDEX <t>_temporal_gist ON <t> USING gist (tenant_id, valid_time, txn_time);` — enables `&&` and `@>` at scale.
   - `CREATE INDEX <t>_tenant_current ON <t> (tenant_id) WHERE upper(txn_time) IS NULL;` — hot path for current-view queries.
   - Business-key uniqueness via exclusion constraint, not UNIQUE:
     ```sql
     EXCLUDE USING gist (
       tenant_id    WITH =,
       business_key WITH =,
       valid_time   WITH &&
     ) WHERE (upper(txn_time) IS NULL)
     ```
     Requires `btree_gist` (enabled in `0001_extensions.sql`).

5. **Canonical TS envelope in `@cortex/canonical-schema`.**
   - `TstzRange` interface:
     ```ts
     interface TstzRange {
       lower: Date;
       upper: Date | null;
       lowerInclusive: boolean; // always true for our convention
       upperInclusive: boolean; // always false for our convention
     }
     ```
   - `BiTemporalRow<T>` as an intersection type — domain fields live alongside temporal columns at the row level, matching the actual row shape (no `payload` sub-column):
     ```ts
     type BiTemporalRow<T> = T & {
       valid_time: TstzRange;
       txn_time: TstzRange;
     };
     ```
   - Parser / serializer handles Postgres's `[2026-04-22T...,)` wire format; zod schemas validate on service boundaries.

## Rationale

- **`tstzrange` over 4 scalar columns.** Postgres's GiST range index is what makes this tractable. Scalar columns force expression-indexed workarounds, defeat `&&`, and litter every query with `(x >= lower AND x < upper)` conjunctions.
- **Trigger-based SCD over application-layer.** Every write path — API, background job, psql operator — is subject to the same rule. Application-layer SCD is one forgotten INSERT away from a data-integrity bug.
- **`NULL` upper bound over `'infinity'`.** Both are valid; `NULL` is cheaper to index (`upper(x) IS NULL` is a simple btree-friendly discriminator) and unambiguously means "open". `'infinity'` forces a second GiST comparison on the common current-row query.
- **Exclusion constraint over UNIQUE.** UNIQUE on `(tenant_id, business_key)` is incompatible with SCD — old closed rows carry the same business key. Exclusion allows overlap-free business-key scoping while preserving history.
- **Predicate over retrieval function.** The spec wording (F03: `as_of_valid`, `as_of_latest`, `history`) suggests retrieval functions with shape `(table, entity_id, timestamp) -> row`. In Postgres these would either require dynamic SQL inside PL/pgSQL (opaque to the planner, non-composable, loses types), or one hand-written function per table. A single predicate `at_time_t(valid_time, txn_time, ts_valid, ts_txn)` is:
  - **Composable** — inlines into any query, any join, any CTE.
  - **Planner-friendly** — `IMMUTABLE PARALLEL SAFE` pure SQL means the query planner sees through it to the underlying GiST index on `(tenant_id, valid_time, txn_time)`.
  - **Type-preserving** — callers write `SELECT * FROM tenants WHERE cortex.at_time_t(...)` and retain the native row type.
  - **Idiomatic Postgres** — mirrors how built-in range operators are used.
    Per-table retrieval wrappers (`cortex.<table>_as_of_valid(entity_id, ts)` etc.) are trivially built on top of the predicate. The spec's named retrieval functions become one-line sugar over the primitive, rather than the primitive itself.
- **Helpers as SQL, not PL/pgSQL.** `IMMUTABLE PARALLEL SAFE` SQL functions inline at plan time; PL/pgSQL would be opaque to the planner.

## Consequences

### Positive

- Every temporal query uses the same three range operators (`@>`, `&&`, contains).
- SCD enforced at the database boundary, not in each service.
- Migration authors copy a 6-line recipe (tstzrange columns + trigger + GiST index + exclusion constraint) per table, and generate three one-line convenience wrappers per table.

### Negative

- `UPDATE` and `DELETE` physically INSERT rows — storage grows O(writes), not O(live entities). Accepted; F03's entire purpose is audit-grade retention.
- Drizzle's TS type system does not model `tstzrange` natively; per-service Drizzle schemas type these columns via `customType<TstzRange>` shims imported from `@cortex/canonical-schema`.
- Range anchors must be `timestamptz`, not `timestamp` — every query supplying an anchor casts explicitly or uses `now()`.
- The named retrieval functions listed in F03 (`as_of_valid`, `as_of_latest`, `history`, `as_of_known`, `point_in_time_join`) are **not available platform-wide in Phase B**. They materialize per-table when D01 tables land, or platform-wide when a cross-table consumer needs them. Accepted; Phase B ships the primitive, not the full API surface.

### Neutral

- Primary keys remain surrogate UUIDs; business-key uniqueness is the exclusion constraint's job, not the PK's.
- `cortex` schema is created for platform-owned functions and types; `public` stays empty of platform machinery.

## Alternatives considered

1. **Separate `history` tables (Type 6 SCD).** Two tables per entity, moved by trigger. Doubles migration surface, fragments queries. Rejected.
2. **System-versioned tables (`temporal_tables` extension).** Trigger-based, similar end result, but bolts on via an external extension Cloud SQL does not natively ship. Rejected to stay on stock Postgres 17.
3. **Application-layer bi-temporal.** Rejected — integrity depends on every writer.
4. **Four-column representation (`valid_from`, `valid_to`, `txn_from`, `txn_to`).** Rejected — loses GiST index and range-operator ergonomics; indexes degrade to a set of conditional expression indexes.
5. **`as_of_valid(table_name, entity_id, ts)` as the platform primitive.** This is the most natural reading of the spec. Rejected because the only Postgres-native implementations are (a) PL/pgSQL with `EXECUTE format(...)` dynamic SQL — opaque to the planner, loses row typing, non-composable with joins; or (b) one hand-written function per table — same surface area as generating per-table view wrappers, but with a worse composition story. The predicate approach lets `as_of_valid` exist per-table as a **one-line** wrapper over `at_time_t`, keeps the planner honest, and preserves the platform primitive's reuse across future cases (`point_in_time_join`, time-range scans).
6. **`payload`-subfield TS envelope (`{ valid_time, txn_time, payload: T }`).** Rejected — actual rows don't have a `payload` column; domain fields sit alongside temporal columns at the row level. Intersection type (`T & { valid_time, txn_time }`) matches the row shape.

## Implementation notes

- `btree_gist` required for the exclusion constraint's `tenant_id WITH =` clause. Enabled in `0001_extensions.sql` alongside `pgcrypto` and `vector`.
- `cortex` schema created by `0002_bi_temporal_helpers.sql`. Hosts `cortex_scd_trigger()` and `at_time_t()`. `public` stays empty of platform machinery.
- Tables that are not bi-temporal (internal bookkeeping, queue tables) simply don't attach the trigger; this ADR doesn't mandate bi-temporality on every table.
- **Explicitly deferred to first consumer** (per prior-session Decision 8 retrospective):
  - `as_of_known` — system-time-only view. Add when the first service needs "what did we believe at transaction time T" independent of valid time.
  - `point_in_time_join` — join two temporal tables at the same anchor pair. Critical for A01 Feature Store (P4.x); add there.
  - `temporal_union`, `temporal_intersection` — range algebra helpers. Add when a concrete use case arrives; `+` and `*` native operators suffice in the meantime.
    These are F03-spec-listed and will be **added** when needed. The predicate + trigger set in 0002 is the minimum infrastructure; additive functions build on this primitive without changing it.
- Acceptance test at `services/foundation/test/bi-temporal.spec.ts` — insert → update → "as of prior timestamp" returns the pre-update value using `cortex.at_time_t` directly.

### Observation — Drizzle journal timestamps act as a high-water mark (P0.4 Phase B discovery)

`drizzle-kit migrate` applies a migration only when its `folderMillis` (journal `when` field) is strictly greater than `max(created_at)` in `__drizzle_migrations`. Pre-staging placeholder migration files with later `when` values silently blocks future edits to earlier-timestamped files: the file's new content hashes differently, but its `folderMillis` is below the high-water mark, so drizzle-kit skips it without warning.

Phase B initially staged four placeholder files (0001–0004) with sequential `when` values; applying all four on first run consumed the timestamp space. Attempting to fill 0002–0004 in place afterward would have been a silent no-op. Recovery required deleting rows from `__drizzle_migrations`, removing the placeholder files, and trimming `_journal.json` to the genuinely-applied entries.

**Workflow rule:** author SQL → append journal entry with fresh `Date.now()` → `make db-migrate-<env>` → test → commit, one migration at a time. Never pre-stage placeholder files intending to fill them later.

Cross-ref: CLAUDE.md "Database conventions" → "Migrations".

## References

- Cortex v2.2 Spec §F03 Temporal Data Engine — bi-temporal requirement, use cases.
- Cortex v2.2 Spec §F01 §1.4 Data Model — tenant-scoped table convention.
- PostgreSQL docs, Range Types — https://www.postgresql.org/docs/17/rangetypes.html
- PostgreSQL docs, Exclusion Constraints — https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-EXCLUSION
- Snodgrass (2000), _Developing Time-Oriented Database Applications in SQL_ — canonical bi-temporal reference.
- ADR-INFRA-005 — Cloud SQL posture; Postgres 17 availability of all used features.

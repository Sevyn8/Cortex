# Database conventions

> Relocated from CLAUDE.md for context-budget; loaded on demand.

Phase 1 database posture — raw-SQL migrations, bi-temporal primitives, RLS, audit chain.
Deep rationale lives in ADR-DB-001, DB-002, DB-003.

### Migrations

- Raw SQL files in `services/foundation/migrations/`, run by `drizzle-kit migrate`. Drizzle `pgTable` schemas are for app-side typed queries only — not the source of truth for migrations.
- Apply via `make db-migrate-{dev,staging,prod}` (wraps `pnpm db:migrate` with gcloud-injected `PGPASSWORD`). Requires matching `make db-proxy-<env>` in another terminal.
- **Write and apply one migration at a time.** Author SQL → append journal entry with fresh `Date.now()` → apply → test → commit. The `when` field in `_journal.json` is a high-water mark: placeholder files with later `when` values silently block earlier-timestamped edits from ever applying.
- First-consumer principle: helpers like `as_of_valid`, `verify_chain`, advisory locks are **deferred until a service needs them**. Ship the primitive (`at_time_t` predicate; `audit_canonical_hash` function), not the full API surface. See ADR-DB-001 §3 "Deferred helpers", ADR-DB-003 Impl Notes.

### Session variables

- Tenant context flows via `app.tenant_id` (uuid) set per-transaction by F01 middleware (P1.1, not yet built). `cortex.current_tenant_id()` reads it; NULL / empty / invalid → SQLSTATE `42501` fail-closed. See ADR-DB-002.
- **`SET LOCAL` does NOT accept bind parameters** — `SET LOCAL app.tenant_id = $1` raises SQLSTATE `42601`. Use the functional form:
  ```sql
  SELECT set_config('app.tenant_id', $1, true);  -- is_local = true ≡ SET LOCAL
  ```
- Always `SET LOCAL` or `set_config(..., true)` — never `SET SESSION` (leaks across pooled connections).

### Canonical timestamps + hashing

- Postgres `timestamptz` has microsecond precision; JS `Date` has millisecond precision. The default `pg` type parser converts on fetch, silently dropping 3 decimal digits on round-trip.
- **Hash / signature computations over timestamps must be done server-side** (or use a string-preserving `pg` type parser). Sending a JS Date back as `$N::timestamptz` reconstructs with zero-padded µs, changing the canonical form and invalidating the hash.
- Canonical literal for hashing is UTC ISO-8601 µs:
  ```sql
  to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ```
  See `cortex.audit_canonical_hash` (ADR-DB-003 §3).

### Append-only tables

- `audit_event` enforces append-only via a `BEFORE INSERT OR UPDATE OR DELETE` trigger. UPDATE/DELETE raise SQLSTATE `2F002` regardless of role. See ADR-DB-003 §4.
- **TRUNCATE bypasses ROW triggers** — Postgres fires STATEMENT-level triggers on TRUNCATE, not per-row ones. Production service roles must not hold `TRUNCATE` privilege on `audit_event`; dev test setup uses TRUNCATE deliberately for idempotency.
- If absolute append-only is ever required end-to-end, add a `BEFORE TRUNCATE` STATEMENT trigger raising `2F002`.

### `audit_event` row shape

`audit_event` rows wrap event metadata in a `payload` jsonb column (NOT a top-level `after_state` column). Test queries reading audit metadata access via:

```sql
SELECT payload -> 'after_state' ->> 'field' AS field
FROM audit_event WHERE ...
```

The payload jsonb's typical shape:

```json
{
  "before_state": { ... },
  "after_state": { ... },
  ... action-specific fields the emitter populated
}
```

When asserting test expectations on audit metadata, query the payload path directly. Don't assume top-level columns. The actual `audit_event` columns are: `event_id`, `tenant_id`, `actor_type`, `actor_id`, `actor_description`, `action`, `resource`, `payload`, `occurred_at`, `prev_hash`, `curr_hash`, `inserted_at` — only `payload` carries the structured emit data.

### `audit_event` cleanup limitations

`audit_event` has the append-only trigger above that rejects DELETE with SQLSTATE `2F002`. Helpers like `cleanupConfigPlaneState`'s `DELETE FROM audit_event` wrap their query in `.catch(() => undefined)` and silently swallow the failure — so audit rows leak across tests within a session.

Test fixtures must compensate by being defensive in their audit assertions:

- Filter by `tenant_id` AND a test-unique payload field (e.g., `payload -> 'after_state' ->> 'from_draft_id' = $draftId`) to scope queries to the current test's emissions.
- Use `ORDER BY occurred_at DESC LIMIT 1` for "most recent" reads; this naturally returns the current test's row even when older runs left rows for the same tenant.
- For "no rows should exist" assertions, ALWAYS combine `WHERE tenant_id = $1 AND <test-unique field>` — a bare action-name filter will surface false positives from prior tests' rows.

Not filtering this way will surface false positives. Tracked at roadmap §1.15 (cleanup-helper improvement candidates).

### Multi-tenant test isolation via RLS

Multi-tenant isolation tests should EXPLOIT the RLS policy rather than fabricating isolation:

```ts
// Bind tenant B's context; query data created by tenant A
await inTenant(db, tenantB, async (tx) => {
  // Tenant A's drafts/configs are RLS-filtered out.
  // Asserting "not found" naturally validates isolation.
  await expect(analyzeImpact(tx, tenantB, draftIdFromTenantA)).rejects.toThrow(
    ImpactAnalysisDraftNotFoundError,
  );
});
```

RLS does the isolation work; the test verifies the policy enforces it. Canonical multi-tenant test pattern; surface for any future module's tests. F04 Slice D's `impact-analysis.spec.ts` shows the pattern in `analyzeImpact — end-to-end > multi-tenant isolation` test.

### Testing RLS-protected tables

- Vitest runs as `postgres` (superuser). By default, table owners bypass RLS — policy tests would silently pass without enforcing anything.
- Set `ALTER TABLE <t> FORCE ROW LEVEL SECURITY` in `beforeAll`, pair with `NO FORCE` in `afterAll`. Real Phase 1 tables do NOT need FORCE in production (F01 middleware never runs as superuser).
- Use `withTenantContext(pool, tenantId, fn)` / `withoutTenantContext(pool, fn)` from `@cortex/canonical-schema/rls-test` to set / unset tenant context inside a test transaction. The helpers use `set_config` under the hood for the reason in the "Session variables" section above.
- **TypeScript inference threshold note.** In type-heavy spec files (e.g., 20+ `withTenantContext` call sites + complex fixture types), TypeScript inference may fall back to `any` for the `tx` parameter on later lambdas after a cumulative-complexity threshold — earlier identical patterns succeed, later ones don't. Workaround: explicit `(tx: PoolClient) => ...` annotation (import `type { PoolClient } from 'pg'`). Surfaced in P1.6 Slice A `packages/feature-flags/test/eval.spec.ts`.

### Test-fixture tables need explicit GRANTs

CI bootstrap (`scripts/db-reset-local.sh`) runs `GRANT ALL ON ALL TABLES IN SCHEMA public TO test_user` once. **Tables created in `beforeAll` AFTER bootstrap don't inherit that grant.** Each fixture table needs an explicit `GRANT` after `CREATE TABLE`:

```ts
await pool.query('CREATE TABLE my_fixture (...)');
await pool.query('GRANT ALL ON my_fixture TO test_user');
```

Without it, tests using `withTenantContext` (which connects as `test_user`) fail with `permission denied for table my_fixture`. This pattern has bitten F04 Slice B (lifecycle tests) and F03 Slice C (SCD policy trigger tests) — second-time discovery is the codification trigger. New fixture-creation helpers should bake the GRANT in by default.

### PL/pgSQL trigger row-type preservation

When dispatching dynamically on column names in a PL/pgSQL trigger, **avoid reassigning `NEW` via `EXECUTE INTO`**:

```sql
-- WRONG: NEW becomes a generic `record` type; later NEW.id := ... fails
-- with "record NEW has no field id"
EXECUTE format('SELECT jsonb_populate_record(NULL::%I.%I, $1)',
               TG_TABLE_SCHEMA, TG_TABLE_NAME)
  INTO NEW USING new_jsonb;
```

Dynamic SQL `INTO NEW` loses the trigger-row's typed-field info. Instead, use the **direct form** with `NEW` itself as the template-record:

```sql
-- CORRECT: passing NEW as the template preserves the trigger-row type
NEW := jsonb_populate_record(
  NEW,
  jsonb_build_object(sibling_col, to_jsonb(OLD) -> source_col)
);
```

`jsonb_populate_record(template anyelement, jsonb)` returns the same type as `template`. Passing `NEW` keeps NEW typed as the table's row, so subsequent `NEW.<field> := ...` access works. Avoid dynamic SQL when the static form suffices.

Discovered during F03 Slice C migration 0017 trigger work.

### Reshaping tenant-scoped substrate tables

When migrating a tenant-scoped table from monolithic-per-tenant to per-(tenant, namespace) (or any analogous "split a single row into per-key rows"), pre-enumerate the reconciliation surface workspace-wide. **Three classes** to grep:

1. **INSERT sites** (raw SQL + Drizzle `insert(...)`) — every writer needs the new column.
2. **SELECT sites that returned "the only row" or "the latest row"** per tenant — they now need namespace filters to preserve semantics. **This class fails quietly** at planning time; a `INSERT INTO <table>` grep won't find it because it's a SELECT.
3. **Drizzle ORM calls** (`from(...)`, `insert(...)`, `update(...)`) — raw-SQL grep misses these.

```bash
grep -rn "INSERT INTO <table>\|FROM <table>" workspace
grep -rn "insert(<drizzleTableName>)\|from(<drizzleTableName>)" workspace
```

Pre-push verification for substrate-table reshape commits MUST be `pnpm vitest run` **workspace-wide**, not a scoped subset. Read-class failures only surface when fixtures from other namespaces exist; CI is the fallback if local skips them.

**Workspace-wide test runner caveat.** `pnpm test` workspace-wide runs vitest in turbo-parallel mode and hits a pre-existing race involving `audit-chain.spec.ts`'s FORCE RLS toggle racing with parallel suites' `audit_event` INSERTs. The race is timing-dependent and apparently doesn't manifest in CI. Locally, fall back to per-package serial (run vitest in each affected package's directory) as the reliable pre-push gate; CI is the canonical workspace-wide gate. Tracked for fix at `docs/future-roadmap.md` §1.13.

Pad reshape-reconciliation estimates to 2× the source-file-only estimate. Slice A's 1-hr A.6 estimate landed at ~1.5 hr after counting the test-fixture surface (+~30 min) and the CI-caught read-class fix (+~30 min).

Reference: `docs/planning/p1.4-f04-configuration-plane-scope.md` §5 Risk Register (Slice A's reconciliation discovery, including the quotas reads class missed by the original grep).

### Bi-temporal table convention `[F03 Slice A]`

When a tenant-scoped table is a domain entity (retains valid-time + transaction-time history per ADR-DB-001), use the bi-temporal pattern. When it's bookkeeping (queue, counter, lookup, append-only audit log), it isn't bi-temporal.

**When to use:** domain entities under `tenant_id` with versioning needs (products, hierarchy nodes, facts, etc.).

**When NOT to use** (allowlist of bookkeeping tables — never bi-temporal): `tenant`, `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`, `legal_hold`, `audit_event`. New bookkeeping tables: opt out by adding a directive immediately before `CREATE TABLE`:

```sql
-- @bi-temporal: skip
CREATE TABLE my_bookkeeping_table ( ... );
```

The lint enforces fail-closed — a tenant-scoped (`tenant_id`-bearing) table that is not in the allowlist AND lacks the directive AND lacks the recipe → CI fail. Pre-commit hook (`lint-staged`) catches at commit time; `.github/workflows/ci.yaml`'s `Lint bi-temporal migrations` step catches `--no-verify` bypasses.

**Recipe** (post-0006 trigger binding; cross-ref migration 0006 for the ms-precision normalization that makes JS-Date round-trip lossless):

- Two `tstzrange` columns: `valid_time` + `txn_time`
- Trigger: `BEFORE INSERT OR UPDATE OR DELETE` calling `cortex.cortex_scd_trigger()`
- GiST index on `(tenant_id, valid_time, txn_time)`
- Current-version partial index `WHERE upper(txn_time) IS NULL`
- Exclusion constraint on `(tenant_id, business_key, valid_time)` `WHERE upper(txn_time) IS NULL`

**Scaffold** (preferred; produces the recipe SQL ready to redirect into a migration file):

```bash
make db-scaffold-bitemporal TABLE=<name> BUSINESS_KEY=<col> [WITH_WRAPPERS=y|n]
```

The `WITH_WRAPPERS` flag generates per-table query wrappers (`cortex.<table>_as_of_valid`, `cortex.<table>_as_of_latest`, `cortex.<table>_history`) over the shared `cortex.at_time_t` predicate. Defaults to `y`.

- `WITH_WRAPPERS=y` (default; almost always): generates the 3 wrappers. Locks per-table query shape consistent across all bi-temporal tables; new consumers don't redo the design call. Closes roadmap §5.2 on a per-table basis as scaffolds run.
- `WITH_WRAPPERS=n` (rare): generates columns + trigger + indexes only. Use when the access pattern hasn't been designed yet AND the table needs to ship bi-temporal for future-compat. The wrappers can be added later via a follow-up migration. ADR-DB-001 §Implementation Notes deferral pattern remains the fallback.

The scaffold writes to stdout; redirect to a migration file path of your choosing. The scaffold deliberately does NOT touch `services/foundation/migrations/meta/_journal.json` — append the journal entry manually per the high-water-mark discipline (ADR-DB-001 §Implementation Notes).

**Backfill** (legacy tables that exist without bi-temporal columns):

```sql
SELECT cortex.backfill_bitemporal('public', 'tablename', 'business_key_col');
```

Idempotent — re-running on an already-backfilled table is a no-op. Currently zero legacy tables in the codebase need this; the helper future-proofs reclassification (a bookkeeping table that becomes domain) and external imports.

**Querying bi-temporal data** — use `@cortex/temporal-query` (F03 Slice B + B.5). Composable functions over `cortex.at_time_t`:

Row-version (id-based; Slice B):

- `asOf<T>(client, tenantId, table, id, asOfBusinessTs, asOfSystemTs?) → BiTemporalRow<T> | null`
- `currentState<T>(client, tenantId, table, id) → BiTemporalRow<T> | null`
- `history<T>(client, tenantId, table, id) → BiTemporalRow<T>[]`
- `between<T>(client, tenantId, table, id, from, to, asOfSystemTs?) → BiTemporalRow<T>[]` — closed-open `[from, to)`
- `diff<T>(client, tenantId, table, id, t1, t2) → { before, after, changedColumns }` — `@experimental`; see caveat below

Entity-level (business-key-based; Slice B.5):

- `asOfByKey<T>(client, tenantId, table, keyColumn, keyValue, asOfBusinessTs, asOfSystemTs?) → BiTemporalRow<T> | null`
- `diffByKey<T>(client, tenantId, table, keyColumn, keyValue, t1, t2) → { before, after, changedColumns }`

Public API takes a `Queryable` interface (Q-NEW-F03B-5; productization-critical lock) — `pg.Pool`, `pg.PoolClient`, drizzle's underlying client, and test mocks all satisfy it. `tenantId` passed as a query parameter on every call (Q-NEW-F03B-6); RLS stays as defense-in-depth backstop. Returns are nullable for single-row functions (`null` on no match) and `T[]` (never `null`) for collection functions. Closed-open ranges throughout (matches `tstzrange` convention end-to-end). tRPC handlers + SQL views deferred to first-consumer per Q-NEW-F03B-1; tRPC will land in `@cortex/temporal-query/trpc` secondary export, SQL views land per-table at the consuming F-/D-series migration's site.

**Table-name validation:** the `table` argument to all 5 functions must match `/^[a-z][a-z0-9_]{0,62}$/` — snake*case identifier, 1–63 chars (Postgres `NAMEDATALEN-1` limit). Lowercase first char, then `[a-z0-9*]`. **Generic regex, NOT an allowlist** of known bi-temporal tables — no maintenance surface as new bi-temporal tables land. Names that don't match throw at the call site (`temporal-query: invalid table name ...`). Table names cannot be parameterized in Postgres prepared statements; the regex is the SQL-injection guard.

**`asOf` system-anchor default — closed prior versions need explicit `asOfSystemTs`.** The default `asOfSystemTs = now()` reaches only the row whose `txn_time` is currently OPEN. Prior-version rows closed by an SCD trigger UPDATE (which sets the OLD row's `txn_time` upper bound to `now()` AT THAT MOMENT) require an explicit past system-anchor — typically `asOfSystemTs = asOfBusinessTs` for "what was the world state at moment T". Worked example in `packages/temporal-query/src/as-of.ts` JSDoc. The asymmetric default surprised an experienced operator on first attempt; the explicit-anchor pattern is now part of the contract docs.

**`diff` is row-version scoped (`@experimental`).** It operates on a specific row id, comparing the SAME row at two timestamps. For entity-level diff across business identity (the headline F03 "what changed about this product over time" use case), use **`diffByKey`** — same shape, but resolves the entity at each timestamp via `(tenant_id, keyColumn = keyValue)`. The row-version `diff` primitive is useful for narrow scenarios — correction histories, txn_time-axis comparisons within a single row generation, no-change verification — and is NOT the right tool for "show me what changed about this product over time." The SCD trigger rotates `id` on UPDATE (`NEW.id := gen_random_uuid()`), so cross-version comparison via the row-version primitive requires a business-key resolver — which `diffByKey` provides.

**`diffByKey` defaults SYMMETRIC (historical-snapshot mode); `diff` defaults `systemAnchor=now`.** This asymmetry is deliberate. Each `t1` / `t2` passed to `diffByKey` is treated as BOTH the business AND system anchor inside the internal `asOfByKey` calls — i.e., "what did the system know at t1 about the world at t1?". Row-version `diff` defaults each anchor's system axis to `now()`, which is the source of the F03 spec acceptance test bug closed in commit `a7c9a23`. The entity-level diff's symmetric default avoids that surprise structurally — the headline use case is comparing snapshots, so the natural default IS historical-snapshot. Both behaviors documented in JSDoc + this CLAUDE.md callout.

**`asOfByKey` keeps `asOf`'s asymmetric default** (`systemAnchor = now()`) because the single-anchor query has the same "current belief vs historical snapshot" choice that `asOf` does — passing only a business anchor reads "what does the system currently believe was true at businessTs". To reach a closed prior version (e.g., for a forensic replay), pass an explicit past system anchor — typically `asOfSystemTs = asOfBusinessTs`. Same idiom as `asOf`.

**`asOfByKey` / `diffByKey` throw on multi-row match (D13).** The substrate exclusion constraint on bi-temporal tables only enforces no-overlap on currently-OPEN rows (`WHERE upper(txn_time) IS NULL`). Closed historical rows can in principle overlap; if a multi-row match surfaces, the library throws with `temporal-query: multiple rows match (...) — substrate constraint violation; check SCD exclusion constraint on <table>.` Loud failure beats non-deterministic row selection — exposes upstream SCD bugs rather than masking them.

**Composite (multi-column) business keys are out of scope for Slice B.5.** `keyValue` is `string | number`. Most bi-temporal entities have single-column business keys (sku, customer_id, order_number). Multi-column composite-key support deferred to first-consumer per ADR-DB-001 deferral pattern.

**Cross-refs:**

- ADR-DB-001 (primary contract; recipe rationale + alternatives rejected — especially Alternative 4 (4-scalar columns) and Alternative 5 (named retrieval funcs as platform primitives))
- Migration 0002 (`cortex.cortex_scd_trigger` + `cortex.at_time_t`); the file's header recipe was post-0006-corrected in F03 Slice A.
- Migration 0006 (ms-precision quantum) — JS-Date round-trip safe.
- `docs/planning/f03-temporal-data-engine-scope.md` (multi-phase close timeline; tracks Slice C / D deferrals to F04 / D04)
- `docs/planning/f03-slice-A-scope.md` (SD-locked decisions, especially Q-NEW-F03A-1 `WITH_WRAPPERS` synthesis and SD5 lint scope)
- `packages/temporal-query/src/index.ts` (Slice B library; Q-NEW-F03B locks on Queryable, tenantId parameterization, nullable returns, closed-open ranges, diff shape)

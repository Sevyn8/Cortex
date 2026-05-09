# F03 Slice B.5 — `asOfByKey` + `diffByKey` entity-level temporal queries

> Scoped 2026-05-09 in the same session that closed Slice B (`de84fb4`/`888249d`/`a7c9a23`). Slice B.5 is a fix-it follow-up — NOT a regular F-/D-series slice; one commit on main via PR, no full slice ceremony (no A/B/C/D phases, no HOLDs).
>
> **Scope expansion 2026-05-09**: original scope was single-function `diffByKey`; expanded to the function pair (`asOfByKey` + `diffByKey`) per operator post-lock instruction. Motivation: Slice B's `asOf` line-99 test bug — the test author wanted entity-level lookup ("what was this product at tBetween") but reached for the row-version primitive. `asOfByKey` closes that confusion structurally; ~30 min incremental cost.

## Why

Slice B's `diff(client, tenantId, table, id, t1, t2)` is row-version scoped. It compares the SAME row at two timestamps. The SCD trigger (migration 0002) rotates `id` on UPDATE (`NEW.id := gen_random_uuid()`), so cross-version comparison via `diff(id, ...)` against a closed prior version is **structurally impossible** without a business-key resolver — and the library deliberately doesn't carry one (it doesn't know which column is the business key for any given table).

The headline F03 use case — _"create retail.Product → update price → show me what changed"_ — requires entity-level resolution: at each timestamp, find the row whose `(tenant_id, business_key)` matches, then compare. That's `diffByKey`.

`diff` was correctly marked `@experimental` in `a7c9a23` with the caveat documented in CLAUDE.md "Querying bi-temporal data". Slice B.5 ships the entity-level primitive that resolves the F03 spec scenario.

## Function pair (D9)

```ts
// Single-anchor entity lookup (companion to row-version `asOf`)
export async function asOfByKey<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  keyColumn: string,
  keyValue: string | number,
  asOfBusinessTs: Date,
  asOfSystemTs?: Date,
): Promise<BiTemporalRow<T> | null>;

// Two-anchor entity diff (companion to row-version `diff`)
export interface DiffByKey<T> {
  before: BiTemporalRow<T> | null;
  after: BiTemporalRow<T> | null;
  changedColumns: (keyof T)[];
}

export async function diffByKey<T>(
  client: Queryable,
  tenantId: string,
  table: string,
  keyColumn: string,
  keyValue: string | number,
  t1: Date,
  t2: Date,
): Promise<DiffByKey<T>>;
```

Both resolve the entity at each timestamp via `(tenant_id, <keyColumn> = <keyValue>) + at_time_t(valid_time, txn_time, businessTs, systemTs)` predicates. `diffByKey` returns the same shape as row-version `diff` — `{ before, after, changedColumns }` — with the same base EXCLUDED list (`['id', 'tenant_id', 'valid_time', 'txn_time']`) PLUS dynamic exclusion of `keyColumn` (D14).

## Design locks (D9-D16)

- **D9 — function pair**. `asOfByKey` (single-anchor) + `diffByKey` (two-anchor). Both share the entity-resolution predicate `(tenant_id, keyColumn = keyValue) + at_time_t(valid_time, txn_time, businessTs, systemTs)`.
- **D10 — system-anchor defaults**:
  - `asOfByKey`: optional `asOfSystemTs` parameter; defaults to `now()`. **Matches `asOf`'s asymmetric default** — single-anchor query has the same "current belief vs historical snapshot" choice. To reach a closed prior version, pass an explicit past system anchor (typically `asOfBusinessTs`).
  - `diffByKey`: NO system-anchor parameter. Internally calls `asOfByKey(..., t, t)` for both `t1` and `t2` — **historical-snapshot mode by default**. **CRITICAL ASYMMETRY** with row-version `diff` which defaults each anchor's system axis to `now()`. Rationale: the headline use case for `diffByKey` IS comparing entity snapshots at two past timestamps; default-now would replicate the surprise that bit `asOf` (line-99 test bug closed in `a7c9a23`). Documented in JSDoc + CLAUDE.md.
- **D11 — `keyColumn` validation**: same regex as the existing table-name validator (`/^[a-z][a-z0-9_]{0,62}$/`). The validator was renamed `validate-table.ts` → `validate-identifier.ts` with a generic `validateIdentifier(name, kind: 'table' | 'column')` shape. SQL-injection guard since column names can't be parameterized in prepared statements (same rationale as the table-name validator). Throws `temporal-query: invalid column name <name>...`.
- **D12 — `keyValue` type**: `string | number`. Composite (multi-column) business keys explicitly out of scope; documented as future work in JSDoc. Most bi-temporal entities have single-column business keys (sku, customer_id, order_number, etc.). Multi-column support deferred to first-consumer per ADR-DB-001 deferral pattern.
- **D13 — multiple-rows-at-timestamp behavior**: internal helper queries WITHOUT `LIMIT`. If >1 row returns, throw with explicit error message:
  ```
  temporal-query: multiple rows match (tenant_id=$1, keyColumn=$2)
  at businessTs=<iso> systemTs=<iso> — substrate constraint violation;
  check SCD exclusion constraint on <table>.
  ```
  Loud failure beats non-deterministic row selection — exposes upstream SCD bugs rather than masking them. The substrate exclusion constraint enforces no-overlap only on currently-OPEN rows (`WHERE upper(txn_time) IS NULL`); closed historical rows can in principle overlap, so this guard is required.
- **D14 — EXCLUDED list for `diffByKey`**: base list `['id', 'tenant_id', 'valid_time', 'txn_time']` (matches `diff`) PLUS dynamic exclusion of the caller-supplied `keyColumn`. The business key is tautologically unchanged (we looked up both rows by that exact value); including it would clutter every entity-level diff with a stale "key changed" report. Implementation: build `excluded` Set at runtime from base const + `keyColumn` parameter.
- **D15 — acceptance test scenarios**: F03 spec scenario via `diffByKey` + 4 minimum additional cases (asOfByKey past-anchor lookup, asOfByKey null-when-absent, asOfByKey invalid-column rejection, asOfByKey multi-row-substrate-violation throws).
- **D16 — `diff` `@experimental` marker stays**. Adding `diffByKey` doesn't make `diff` non-experimental. Row-version `diff` remains useful only for narrow scenarios (correction histories, txn_time-axis comparisons within a single row generation). Keep the marker; CLAUDE.md note continues to point at `diffByKey` for the headline use case.

## `changedColumns` semantics (`diffByKey`)

Identical to row-version `diff`, with the D14 dynamic-exclusion of `keyColumn`:

- both non-null → shallow-equality scan over non-EXCLUDED keys
- exactly one null → union of non-EXCLUDED keys present in the non-null side
- both null → `[]`

## Test scope

The F03 spec acceptance scenario rewritten with `diffByKey`:

```ts
it('diffByKey resolves entity changes across SCD-rotated versions', async () => {
  const v1 = await insertProduct({
    tenantId: TENANT_A,
    sku: 'SKU-DBK-1',
    name: 'Widget',
    priceCents: 1000,
  });
  await new Promise((r) => setTimeout(r, 30));
  const tBefore = new Date();
  await new Promise((r) => setTimeout(r, 30));
  await pool.query(`UPDATE retail_product SET price_cents = 1500 WHERE id = $1`, [v1]);
  await new Promise((r) => setTimeout(r, 30));
  const tAfter = new Date();

  const result = await diffByKey<RetailProduct>(
    pool,
    TENANT_A,
    'retail_product',
    'external_sku',
    'SKU-DBK-1',
    tBefore,
    tAfter,
  );

  expect(result.before?.price_cents).toBe(1000);
  expect(result.after?.price_cents).toBe(1500);
  expect(result.changedColumns).toEqual(['price_cents']);
});
```

Plus error-path coverage for invalid `keyColumn`, missing-entity, and full-EXCLUDED-list disjoint sides — mirroring the existing `diff.spec.ts` shape.

## Implementation notes

- **No SQL changes** — uses existing `cortex.at_time_t` predicate.
- **Two `pool.query` calls + shallow equality scan** — same shape as current `diff` implementation, just with a different WHERE clause.
- **Lives at**: `packages/temporal-query/src/diff-by-key.ts`. Re-export from `src/index.ts`.
- **Test fixture** — `retail_product.sql` already covers the schema; no new fixture file.
- **CLAUDE.md "Querying bi-temporal data"** subsection update: replace the `diff is row-version scoped (@experimental)` callout with a `diffByKey` paragraph documenting the entity-level use case as the recommended path for "what changed" queries. Keep `diff` `@experimental` for narrow scenarios (correction histories, txn_time-axis comparisons within a single row generation).

## Effort estimate

~1.5 hr:

- 30 min — `diffByKey` implementation + identifier validation reuse
- 30 min — test file (acceptance scenario + 3-4 error paths)
- 15 min — CLAUDE.md update + JSDoc cross-references
- 15 min — local verification + PR

## Single-commit-via-PR pattern

NOT a full slice. No HOLD ceremony. One commit on a `chore-f03-slice-b5-diff-by-key` branch (or similar slug), open PR, CI green, `gh pr merge --merge --delete-branch`. Mirrors the post-2026-05-09 trunk-with-PR-gating workflow per CLAUDE.md `## Branching & PR`.

## Acceptance — flips F03 module-row?

**No.** F03 module-row stays unchecked per D4 — Slice C is blocked by F04, Slice D by D04 + S01 + SCR-08. Slice B.5 closes the gap left by Slice B's `@experimental` marker on `diff` but doesn't unblock C or D. Module-row flips only at all-4-slices ✓.

## References

- Slice B squash (`de84fb4`) — primitives that diffByKey builds on (`Queryable`, `validateTableName`, `parseTstzRange`, EXCLUDED list)
- Slice B fix (`a7c9a23`) — `diff` `@experimental` marker + CLAUDE.md caveat that motivates this slice
- ADR-DB-001 — bi-temporal substrate; `cortex.at_time_t` predicate
- `docs/planning/f03-temporal-data-engine-scope.md` — F03 multi-phase close timeline
- `docs/planning/f03-slice-B-gate-evidence.md` — Slice B close + B.5 deferral note
- CLAUDE.md `## Querying bi-temporal data` — subsection updated post-B.5 to recommend `diffByKey` for entity-level queries

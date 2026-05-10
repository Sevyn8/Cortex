# F04 Slice D — Impact analysis + breaking-change blocker

> Cross-ref: `docs/planning/p1.4-f04-configuration-plane-scope.md` §2 Slice D + §3 Q-NEW-F04D.
>
> Populated 2026-05-10 at HOLD #3 close. Slice D ships breaking-change detection + promote-blocking on top of Slice C's resolver/cache substrate. `analyzeImpact(db, tenantId, draftId)` returns a structured `ImpactReport` covering three orthogonal breaking-change axes (`key_removed` / `schema_incompatible` / `policy_block`). `promoteDraft` accepts `confirmBreakingChanges?: true`; without it, breaking changes throw `ImpactBlockedError` and a `CONFIG_PROMOTE_BLOCKED` audit row commits in a SEPARATE transaction. With override, `CONFIG_VERSION_PROMOTED`'s payload carries enriched `breaking_changes_overridden` + `affected_consumers` metadata.

## Sub-decision locks (HOLD #1)

Three Q-NEW-F04D items were pre-defined in module scope §3 (D-1 / D-2 / D-3); five new items (D-4 through D-8) emerged at HOLD #1 to cover registry-shape reconciliation, key-path granularity, diff mechanism, audit emissions, and ImpactReport shape. Module-scope canonical numbering was preserved (lesson from Slice C kickoff).

| ID               | Lock                                                                                                                | Rationale                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-F04D-1** | At-startup consumer registration (parallels `registerAuditActions`)                                                 | Already satisfied by Slice C's `registerConfigConsumer`. Lock confirms structural pattern is correct; no Slice C surface change required. Lazy registration would race against impact lookups.                                                                                        |
| **Q-NEW-F04D-2** | All three breaking-change axes — `key_removed` + `schema_incompatible` (interpretation 2a) + `policy_block`         | Three orthogonal axes detected by different mechanisms. **(2a) interpretation locked** — schema-version drift breaking consumer pins (NOT data-vs-schema, which is `validateDraft`'s job in Slice B). Each axis surfaces independently in `ImpactReport.breaking_changes[].kind`.     |
| **Q-NEW-F04D-3** | Option flag on `promoteDraft` — `confirmBreakingChanges?: true`                                                     | Module-scope recommendation. Single API surface; no separate `confirmAndPromote`. Override emits enriched `CONFIG_VERSION_PROMOTED` payload (per Q-NEW-F04D-7).                                                                                                                       |
| **Q-NEW-F04D-4** | Extend Slice C's `registerConfigConsumer` in-place with optional impact fields                                      | New optional fields: `consumerModule?: string`, `breakingChangePolicy?: 'warn' \| 'block'`, `keyPaths?: string[]`. Backward-compat preserved (Slice C callers untouched). Impact-skipped when `consumerModule` is omitted (matches D5 spirit of one registration per consumer).       |
| **Q-NEW-F04D-5** | Sub-namespace key paths via optional `keyPaths` field; namespace-level when omitted                                 | Forward-compat with namespace-level default; sub-namespace narrows to specific paths. Bidirectional `pathMatchesKeyPath` semantics (consumer keyPath prefix-of diff path OR vice versa) — one-way matching would miss half the cases.                                                 |
| **Q-NEW-F04D-6** | Structural JSON diff for axis 1; schema-registration-event detection for axis 2a at analyze-time (NOT registration) | Phase 1 simplicity. Zod-semantic schema-shape diff (deep schema comparison) DEFERRED to first-consumer-driven. Analyze-time detection (not registration-time) because consumer-set may not be complete at registration.                                                               |
| **Q-NEW-F04D-7** | ONE new verb `CONFIG_PROMOTE_BLOCKED` (REJECT) + enriched `CONFIG_VERSION_PROMOTED` payload on override path        | Quotas/rate-limit precedent for REJECT. Block-path emits new verb; override-path enriches existing verb. Analyze-without-block is silent (no audit row) — would double the F04 audit volume. Block-path emit lives in a SEPARATE transaction (the attempt's transaction rolled back). |
| **Q-NEW-F04D-8** | Full `ImpactReport` shape + `AffectedConsumer` + `BreakingChange` + `Warning` + supporting types                    | All exported from package barrel for future HTTP-layer consumers (P1.5+). Snake_cased fields match audit-payload convention (`consumer_module`, `matched_key_paths`, `breaking_change_kinds`).                                                                                        |

## Build plan (D.1 - D.8)

| Step      | Scope                                                                                                                                                                                                            | Estimate   | Actual                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| **D.1**   | Extend `consumer-registry.ts` with optional impact fields + `getImpactEligibleConsumers` helper                                                                                                                  | 0.75 hr    | 0.5 hr                                                                                                  |
| **D.2**   | New `impact-analysis.ts` — `analyzeImpact` + `diffJson` + `pathMatchesKeyPath` + tier-prefix stripping (~280 lines)                                                                                              | 2 hr       | 1.75 hr (refactor mid-D.4 to drizzle `NodePgDatabase` from `Queryable` added ~15 min)                   |
| **D.3**   | New `schema-drift.ts` — `detectSchemaIncompatibilities` over consumer pinned-version (~95 lines)                                                                                                                 | 1 hr       | 0.75 hr                                                                                                 |
| **D.4**   | Wire `promoteDraft` impact-aware: `confirmBreakingChanges` param + `ImpactBlockedError` class + analyzeImpact pre-INSERT call + override-payload helper                                                          | 1.5 hr     | 1.5 hr (incl. seam refactor)                                                                            |
| **D.5**   | Catalog `CONFIG_PROMOTE_BLOCKED` (REJECT) + `emitImpactBlockedAudit` helper in fresh transaction + wire into both ImpactBlockedError catch sites (first attempt + retry)                                         | 0.75 hr    | 0.5 hr                                                                                                  |
| **D.6**   | Barrel exports: `ImpactBlockedError`, `analyzeImpact`, `diffJson`, `pathMatchesKeyPath`, `detectSchemaIncompatibilities`, all 7 ImpactReport-related types, `getImpactEligibleConsumers`, `BreakingChangePolicy` | 0.25 hr    | 0.25 hr                                                                                                 |
| **D.7**   | New `test/impact-analysis.spec.ts` — 27 specs across 5 describe blocks                                                                                                                                           | 2-2.5 hr   | 1.75 hr (incl. fixture-leak workaround for `from_draft_id` filtering and audit_event payload-shape fix) |
| **D.8**   | CLAUDE.md additions (4 sections) + roadmap §1.15 + §1.16 + populate `f04-slice-D-scope.md` from shell + workspace regression                                                                                     | 1-1.5 hr   | 1.25 hr                                                                                                 |
| **Total** |                                                                                                                                                                                                                  | 9.25-10 hr | **~8.25 hr** (under estimate; no design surprises post-D.1 lock)                                        |

## Acceptance — module-scope §2 deliverables

- ✓ `analyzeImpact(db, tenantId, draftId) → Promise<ImpactReport>` exported from `@cortex/config-plane`; walks structural diff + schema-drift detection per Q-NEW-F04D-2 axes.
- ✓ `registerConfigConsumer` extended with optional impact fields per Q-NEW-F04D-4. Slice C callers untouched.
- ✓ `promoteDraft` accepts `confirmBreakingChanges?: true` per Q-NEW-F04D-3. Block path throws `ImpactBlockedError` carrying `ImpactReport`. Override path enriches `CONFIG_VERSION_PROMOTED.after_state`.
- ✓ `CONFIG_PROMOTE_BLOCKED` REJECT verb added to catalog per Q-NEW-F04D-7. Emits in a SEPARATE transaction from the rolled-back attempt — load-bearing test in `impact-analysis.spec.ts` asserts the row exists post-rollback.
- ✓ `ImpactReport` + `AffectedConsumer` + `BreakingChange` + `Warning` + `BreakingChangeKind` + `DiffChangeKind` + `JsonDiffEntry` types exported per Q-NEW-F04D-8.
- ✓ All 117 config-plane tests green serially (`--no-file-parallelism`); 27 new Slice D tests + 89 pre-Slice-D + 1 audit-actions count update.
- ✓ Workspace regression clean: foundation 84/84 + workspace typecheck (30 packages) + lint all green.

## Findings during D.1 - D.8

### D.1 — Optional impact fields preserve Slice C signature

`registerConfigConsumer<T>({ namespace, schema, schemaVersion, defaultValue, ttl?, consumerModule?, breakingChangePolicy?, keyPaths? })`. Slice C consumers don't see new required params. `getImpactEligibleConsumers(namespace) → ConsumerEntry[]` filters to entries where `consumerModule !== undefined`; returns 0 or 1 entries in Phase 1 (single-consumer-per-namespace constraint per roadmap §1.16).

### D.2 — Bidirectional path matching (load-bearing semantic)

Consumer keyPaths and diff paths match in either direction. Consumer registers `['theme','colors']`, diff hits `['theme','colors','primary']` → match (broader-to-narrower). Consumer registers `['theme','colors','primary']`, diff hits `['theme','colors']` → also match (narrower-to-broader; the wholesale change subsumes the specific path). One-way matching would miss half the cases. Edge case: paths that share a leading substring without a dot boundary (e.g., `'theme_colors'` vs `'theme'`) do NOT match — the matcher requires the boundary to avoid false positives.

### D.2 — Two-seam DB API design

Slice C's `Queryable` interface (`pg.PoolClient`-style `.query(sql, params)`) didn't structurally match drizzle's `tx` (drizzle's `.query` is the relational-query-builder API, not raw SQL). Refactored `analyzeImpact` to take `NodePgDatabase<Record<string, never>>` instead of `Queryable`, using `db.execute(sql\`...\`)`. Reasoning: `analyzeImpact`is lifecycle-shaped (transactional, multi-query) — drizzle alignment matches the rest of`lifecycle.ts`. External Phase-2+ HTTP "preview impact" callers wrap their `pg.Pool`with`drizzle()`to use this API.`getConfig`/`resolveConfig`retain the`Queryable`seam — narrower API surface (single read), tested with raw`pg.PoolClient`via`withTenantContext`. **Two seams coexist by design.** Don't speculatively unify.

### D.3 — Schema-drift bidirectionality

Both directions of schema-version drift can produce breakage:

- **M > N (forward drift):** schema bumped after consumer registered. New shape may add required fields the consumer's v=N schema doesn't expect.
- **M < N (backward drift):** data is at an older shape than the consumer's pinned version. Consumer's v=N schema may require fields that don't exist in v=M data.
- **M == N:** drift only happens if the schema was mutated in-place at v=N (per CLAUDE.md `### Schema-version mutation rule`).

`detectSchemaIncompatibilities` always parses; failing-to-parse means incompatibility regardless of direction.

### D.4 — Throw-inside-transaction-then-no-retry pattern

`ImpactBlockedError` thrown inside `attemptPromote`'s transaction propagates out to `promoteDraft`'s outer catch. Distinct from `PromoteConcurrencyError`'s retry-twice path: the block decision is **data-shape-stable** — `analyzeImpact` would return the same report on retry. Promote's outer wrapper short-circuits the retry on `ImpactBlockedError` (re-throws immediately).

### D.5 — Audit-on-error in separate transaction

`CONFIG_PROMOTE_BLOCKED` audit MUST emit in a fresh transaction. The attempt's transaction rolled back when the throw fired; if we tried to consolidate audit emission into the rolled-back transaction, the audit row would roll back too. **Load-bearing test** in `impact-analysis.spec.ts` (`block path also emits CONFIG_PROMOTE_BLOCKED audit row in a SEPARATE transaction`) asserts the audit row exists after the throw — if a future maintainer "consolidates" the emission into the inner transaction, this test catches it.

### D.5 — Dual catch-site behavior on concurrent retry

`promoteDraft`'s retry-on-23505 path opens a fresh attempt. Each attempt's `analyzeImpact` may throw `ImpactBlockedError` independently — the report could differ between attempts if a concurrent promote happened in between. Both emissions audit (one per attempt that threw); two `CONFIG_PROMOTE_BLOCKED` rows in a single user-call indicates a retry path. Auditing both is honest about what attempts happened.

### D.7 — `audit_event` payload jsonb structure (fixture finding)

`audit_event` rows wrap event metadata in a `payload` jsonb column (NOT a top-level `after_state` column). Test queries access via `payload -> 'after_state' ->> 'field'`. Initial draft of `impact-analysis.spec.ts` selected `after_state` directly; surfaced as `column "after_state" does not exist`. Fixed; codified in CLAUDE.md `### audit_event row shape`.

### D.7 — `cleanupConfigPlaneState` audit_event silent-swallow

`cleanupConfigPlaneState`'s `DELETE FROM audit_event WHERE tenant_id = $1` hits the append-only trigger (SQLSTATE `2F002`). The helper's `.catch(() => undefined)` silently swallows the failure — audit rows leak across tests within a session. Block-path "no rows should exist" assertion failed because test 1's successful promote left a `CONFIG_VERSION_PROMOTED` row that test 2 saw. Fix: filter by `payload -> 'after_state' ->> 'from_draft_id' = $draftId` to scope to current test's emissions. Codified in CLAUDE.md `### audit_event cleanup limitations` + tracked at roadmap §1.15.

### D.7 — RLS-as-isolation test pattern

Multi-tenant isolation tests should EXPLOIT the RLS policy rather than fabricating isolation. Bind tenant B's context, query tenant A's data → row is RLS-filtered out → `ImpactAnalysisDraftNotFoundError` surfaces naturally. RLS does the isolation work; the test verifies the policy enforces it. Codified as the canonical multi-tenant test pattern in CLAUDE.md `### Multi-tenant test isolation via RLS`.

### D.7 — Single-consumer-per-namespace constraint

The consumer registry is keyed by namespace alone (`Map<string, ConsumerEntry>`). A second `registerConfigConsumer` for the same namespace overwrites the first. Multi-consumer-aggregation tests had to be reframed as single-consumer-multi-axis (one consumer simultaneously triggering `key_removed` + `schema_incompatible` + `policy_block`). Phase 2 multi-consumer use cases tracked at roadmap §1.16. The `getImpactEligibleConsumers` array-return signature is forward-compat — when multi-consumer ships, callers don't change.

## Test inventory

| Spec                                                                               | Tests                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------- |
| `audit-actions.spec.ts` (Slice A; updated in D.5 — count 6→7 + new verb assertion) | 5                                      |
| `schema-registry.spec.ts` (Slice A/B; unchanged)                                   | 8                                      |
| `migration-0014-backfill.spec.ts` (Slice A; unchanged)                             | 1                                      |
| `get-config.spec.ts` (Slice A; unchanged)                                          | 6                                      |
| `config-draft-constraints.spec.ts` (Slice B; unchanged)                            | 6                                      |
| `lifecycle.spec.ts` (Slice B; unchanged)                                           | 27                                     |
| `rollback.spec.ts` (Slice B; unchanged)                                            | 6                                      |
| `resolve.spec.ts` (Slice C; unchanged)                                             | 30                                     |
| `impact-analysis.spec.ts` (Slice D; new)                                           | 28                                     |
| **Total**                                                                          | **117** (was 89 post-Slice-C; +28 net) |

### `impact-analysis.spec.ts` describe-block breakdown (28 specs)

- **diffJson** (6) — added/removed/modified, nested paths, positional arrays, no-op identity.
- **pathMatchesKeyPath** (5) — both prefix directions, identical, unrelated, no-false-positive on shared substring without dot boundary.
- **detectSchemaIncompatibilities** (4) — breaking on pinned-version mismatch, warning on missing schema, no-findings happy path, multi-consumer per-pin classification.
- **analyzeImpact end-to-end** (9) — `key_removed` via keyPath, namespace-level (no keyPaths), multi-axis aggregation (`key_removed` + `schema_incompatible` + `policy_block` for one consumer), genesis path (schema-drift only), empty-consumer skipped, `tenant.*` and `platform.*` tier-prefix stripping, `ImpactAnalysisDraftNotFoundError`, multi-tenant isolation via RLS.
- **promoteDraft impact-aware integration** (4) — non-breaking promote (no override metadata), block path (throw + carries report + no version row), **separate-transaction audit emission (load-bearing)**, override path (success + enriched payload).

## Architectural framings carried to CLAUDE.md

CLAUDE.md adds the following sections in D.8:

1. `### Impact analysis (Slice D)` (under `## Configuration plane (F04)`) — three-axis breaking-change framing, override/block paths.
2. `### Audit-on-error in separate transaction` — codifies the D.5 pattern with the load-bearing test reference.
3. `### Bidirectional path matching for impact analysis` — codifies the D.2 semantic.
4. `### Dual catch-site behavior — two CONFIG_PROMOTE_BLOCKED rows per call on retry` — codifies the D.5 retry semantic.
5. `### Two-seam DB API design` — codifies the D.2 Queryable-vs-NodePgDatabase split.
6. `### registerConfigConsumer vs registerNamespaceSchema` — codifies the D.1 entry-point split.
7. `### audit_event row shape` (under `## Database conventions`) — codifies the D.7 payload-jsonb finding.
8. `### audit_event cleanup limitations` — codifies the D.7 silent-swallow workaround.
9. `### Multi-tenant test isolation via RLS` — codifies the D.7 RLS-as-isolation pattern.
10. `### Pre-push test verification env-loading` (under `## Local development`) — codifies the `set -a && source .env.local && set +a` bracket pattern.
11. `### WIP commits` (under `## Commit conventions`) — codifies the HOLD #2 commit shape (commitlint type/case constraints + body convention).

## Forward-compat exit criteria

- **Multi-consumer-per-namespace** — when a Phase 2 module needs two consumers on one namespace (e.g., admin UI + runtime worker both registered against `tenant.theme`), unblock per roadmap §1.16. `getImpactEligibleConsumers`'s array-return signature is already forward-compat; the registry's `Map` shape is the substantive change.
- **`audit_event` cleanup-helper improvement** — when test isolation failures cause flaky CI runs OR test-count crosses ~50+ Slice D-style tests, address per roadmap §1.15. Fixture defensive-filter pattern documented in CLAUDE.md works at current scale.
- **Zod-semantic schema-shape diff** — when a consumer needs deeper-than-parse compatibility analysis (e.g., "is this v=2 schema strictly looser than v=1 such that no consumer breaks?"), unblock per Q-NEW-F04D-6 deferral. Phase 1 structural-diff + schema-parse covers the common cases.

## F04 module-row state

**4/5 slices closed: A ✓, B ✓, C ✓, D ✓**

Remaining:

- **Slice E** — git-sync stub + module wrap-up (~2-4 hr per module-scope §6 estimate).

## Cross-feature impact

F04 Slice D unblocks breaking-change protection for any subsequent module consuming F04 (per module-scope §4 line 478). Specifically: P1.5 F05 Schema Evolution, P1.6 Feature Flags, D04 quality rules, UX01 theme tokens, IC01 vertical-package selection, IC02 i18n, AC02 hierarchy schema, PR06 retention policies. Each such consumer becomes a candidate for `registerConfigConsumer` adoption (with `consumerModule` set to opt into impact analysis).

F03 Slice C's `tenant.scd` namespace remains registered via raw `registerNamespaceSchema` (not `registerConfigConsumer`) — outside the impact-analysis surface. Migration to `registerConfigConsumer` is voluntary and operator-deferred (tracked as a future-roadmap candidate; not a Slice D blocker).

## Cross-refs

- Module scope: `docs/planning/p1.4-f04-configuration-plane-scope.md` (D1-D14 + Q-NEW-F04D-1/2/3 surface; HOLD #1 added D-4 through D-8)
- Slice A scope: `docs/planning/f04-slice-A-scope.md`
- Slice B scope: `docs/planning/f04-slice-B-scope.md`
- Slice C scope: `docs/planning/f04-slice-C-scope.md`
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.4
- Source: `packages/config-plane/src/{impact-analysis,schema-drift,consumer-registry,lifecycle,audit-actions,index}.ts`
- Tests: `packages/config-plane/test/impact-analysis.spec.ts` + `audit-actions.spec.ts` (count update)
- CLAUDE.md: `### Impact analysis (Slice D)` + sibling subsections under `## Configuration plane (F04)`; `### audit_event row shape` + `### audit_event cleanup limitations` + `### Multi-tenant test isolation via RLS` under `## Database conventions`; `### Pre-push test verification env-loading` under `## Local development`; `### WIP commits` under `## Commit conventions`
- Roadmap §1.15: `cleanupConfigPlaneState` audit_event silent-swallow
- Roadmap §1.16: Single-consumer-per-namespace registry constraint

# F04 Slice C — Layered resolution + caching

> Cross-ref: `docs/planning/p1.4-f04-configuration-plane-scope.md` §2 Slice C.
>
> Populated 2026-05-09 at HOLD #3 close. Slice C ships the resolver layer over F04's substrate: `resolveConfig<T>(client, tenantId, namespace) → T | null` walks `tenant.<ns>` → `platform.<ns>` → registered in-code default; per-process LRU caches resolved values with TTL; lifecycle helpers (`promoteDraft`, `rollbackVersion`) actively invalidate the cache POST-commit. **Workspace namespace deferred per D14**; cross-tenant defaults live in-code via `registerConfigConsumer` (the third tier).

## Sub-decision locks (HOLD #1)

Operator HOLD #1 adopted module-scope canonical numbering (Q-NEW-F04C-1 through C-4 from `p1.4-f04-configuration-plane-scope.md` §2 Slice C); two new locks (C-5, C-6) added during HOLD #1 to cover invalidation + registration shape that emerged during planning. (Claude Code's HOLD #1 draft proposed a different numbering with overlapping framings; operator clarified that module-scope is canonical and renumbered the new items to C-5 / C-6.)

| ID               | Lock                                                                                                      | Rationale                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q-NEW-F04C-1** | Deepest-wins inheritance: `tenant.<ns>` → `platform.<ns>` → in-code default                               | Pessimistic resolution — first non-null tier wins. Matches the F04 layering doctrine in module scope. Workspace tier deferred per D14.                                                                 |
| **Q-NEW-F04C-2** | Workspace tier deferred (per D14); third tier is in-code default via `registerConfigConsumer`             | F04 substrate is per-tenant only; no cross-tenant slot exists for a platform-default row. Genuine cross-tenant defaults require an in-code tier. Forward-compat to DB-driven without consumer changes. |
| **Q-NEW-F04C-3** | Per-process LRU cache, 60s default TTL, per-consumer overridable via `ttl?: number`                       | Single-replica deploy gets exact consistency on local replica; multi-replica deploy gets up-to-TTL staleness on remote replicas (Redis migration deferred to roadmap §1.12).                           |
| **Q-NEW-F04C-4** | Cache key = `(tenant_id, logical_namespace)` — logical, not literal                                       | Resolver caches the FINAL resolved value (the namespace IS the entity from a consumer's POV); per-tier slots would multiply storage 2-3× without a consumer-visible benefit.                           |
| **Q-NEW-F04C-5** | Active invalidation on `promoteDraft` + `rollbackVersion`, POST-commit, pessimistic across all tiers      | Same-process freshness on lifecycle write paths. Pessimistic across tiers (any tier write invalidates the logical key) — cost is occasional unnecessary re-read; benefit is correctness + simplicity.  |
| **Q-NEW-F04C-6** | `registerConfigConsumer` is a thin wrapper over `registerNamespaceSchema`; registers BOTH tier namespaces | Single API for the common case; explicit `registerNamespaceSchema` remains available for rare callers that don't want the resolver/cache machinery (e.g., F03 Slice C's `tenant.scd` registration).    |

## Build plan (C.1 - C.6)

| Step      | Scope                                                                                                                                          | Estimate | Actual                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| **C.1**   | `resolve.ts` — 3-tier walk (`tenant.<ns>` → `platform.<ns>` → registered default)                                                              | 1.5 hr   | 0.75 hr (cache + registry primitives in-hand made the resolver near-trivial)                        |
| **C.2**   | `cache.ts` — per-process Map-based LRU + TTL eviction + size cap                                                                               | 1 hr     | 1 hr                                                                                                |
| **C.3**   | `consumer-registry.ts` — `registerConfigConsumer` + dual-tier schema registration                                                              | 0.75 hr  | 0.5 hr                                                                                              |
| **C.4**   | Lifecycle integration — `invalidateResolverCacheForLiteralNamespace` helper + 2 post-commit call sites in `attemptPromote` / `attemptRollback` | 0.5 hr   | 0.5 hr                                                                                              |
| **C.5**   | Tests — `test/resolve.spec.ts` (30 tests across layering, cache, invalidation, dual-namespace registration, schema-version pinning)            | 2 hr     | 1.5 hr                                                                                              |
| **C.6**   | Workspace regression + CLAUDE.md `### Layered config resolution` + scope-doc populate + §1.13 broadening                                       | 1.5 hr   | 1.5 hr                                                                                              |
| **Total** |                                                                                                                                                | 7.25 hr  | **~5.75 hr** (faster than estimate — no surprises during test write; pre-validated cache key shape) |

## Acceptance — module-scope §2 deliverables

- ✓ `resolveConfig<T>(client, tenantId, namespace) → Promise<T | null>` exported from `@cortex/config-plane`; walks 3 tiers per Q-NEW-F04C-1.
- ✓ Per-process cache + active invalidation per Q-NEW-F04C-3 / C-5; cache short-circuits DB walk on hit.
- ✓ `registerConfigConsumer` registers schema for both `tenant.<ns>` and `platform.<ns>` per Q-NEW-F04C-6; in-code default per Q-NEW-F04C-2.
- ✓ Lifecycle `promoteDraft` + `rollbackVersion` call invalidation POST-commit; failed transactions leave cache untouched (post-commit gate).
- ✓ All 89 config-plane tests green serially (`--no-file-parallelism`); 30 new Slice C tests + 59 pre-Slice-C tests all pass.
- ✓ Workspace regression clean: 7 dependent packages + foundation + workspace typecheck + lint all green.
- ✓ §1.13 race-surface broadening landed in `docs/future-roadmap.md`.

## Findings during C.1 - C.6

### C.1 — `DEFAULT_CONSUMER_TTL_SECONDS` single source of truth

Initial draft of `resolve.ts` imported the constant from both `cache.ts` (where it didn't actually live) and `consumer-registry.ts` (where it does). Cleaned up to import only from `consumer-registry.ts` — the registry owns the consumer's view of TTL; the cache is a dumb store that takes a per-call TTL as input. No magic-number drift between the two.

### C.2 — Cache-resolved-null distinguishes from miss

`cacheGet` returns `undefined` for miss (key absent or expired) vs `{ value: T | null }` for hit. The wrapping object lets the caller distinguish "resolved to null and cached the null" (avoids re-walking empty tiers) from "no cache state for this key" (do the walk). The resolver caches `null` results to avoid repeated empty walks for namespaces with no consumer + no DB rows.

### C.4 — Strip-prefix helper for literal → logical namespace translation

The cache is keyed on logical namespace (`'theme'`); lifecycle operates on literal namespace (`'tenant.theme'`). Bridge: `invalidateResolverCacheForLiteralNamespace(tenantId, literalNs)` strips known tier prefixes (`tenant.` / `platform.` / `workspace.` for forward-compat — even though workspace tier isn't shipped yet) and invalidates the logical-namespace cache key. Pessimistic: ANY tier write invalidates the single logical-key entry. Cost: occasional unnecessary re-read. Benefit: correctness + simplicity (single entry per logical namespace; no per-tier slot management).

### C.4 — POST-commit placement gates against transaction rollback

`attemptPromote` / `attemptRollback` await `db.transaction(...)`, then call `invalidateResolverCacheForLiteralNamespace(...)`, then return. A failed transaction throws inside the await; the invalidation line is never reached. Tested explicitly in C.5: `PromoteValidationError` (defensive re-validate fail) leaves cache untouched; `RollbackAtGenesisError` (no parent) leaves cache untouched. Same gate applies to retry-twice path (UNIQUE-violation retry) — invalidation only fires on the SUCCESSFUL attempt.

### C.5 — §1.13 race-surface widened by Slice C's heavy column usage

`migration-0014-backfill.spec.ts` (Slice A; unchanged) drops + re-adds `tenant_config_version.namespace`, `parent_version_id`, `schema_version` columns to validate the pre-0014 backfill path. Slice C's `resolve.spec.ts` adds 30 specs hammering the `schema_version` column concurrently. Vitest's intra-package file parallelism re-surfaces the race even within a single package. Mitigation: `--no-file-parallelism` for local pre-push verification (89/89 green serially); CI's environment apparently doesn't manifest the race (single-threaded enough). Broadening landed in `docs/future-roadmap.md` §1.13 hypothesis + references.

### C.6 — `--no-file-parallelism` local discipline locks in for config-plane until §1.13 closes

`pnpm -F @cortex/config-plane test` (default-parallel) is no longer reliable as the local pre-push gate; `pnpm -F @cortex/config-plane exec vitest run --no-file-parallelism` is. CI uses an environment that doesn't manifest the race. Until §1.13 closes (separate test schema OR vitest config-level serialization), the operator runs serial locally + relies on CI for canonical parallel-mode validation.

## Test inventory

| Spec                                                                                                                    | Tests                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `audit-actions.spec.ts` (Slice A; unchanged)                                                                            | 5                                     |
| `schema-registry.spec.ts` (Slice A/B; unchanged)                                                                        | 8                                     |
| `migration-0014-backfill.spec.ts` (Slice A; unchanged)                                                                  | 1                                     |
| `get-config.spec.ts` (Slice A; unchanged)                                                                               | 6                                     |
| `config-draft-constraints.spec.ts` (B.1; unchanged)                                                                     | 6                                     |
| `lifecycle.spec.ts` (B.2-B.4; unchanged at source — C.4 wires invalidation; tests cover end-to-end via lifecycle paths) | 27                                    |
| `rollback.spec.ts` (B.5; unchanged)                                                                                     | 6                                     |
| `resolve.spec.ts` (Slice C; new — layering, cache, invalidation, dual-namespace, schema-version pinning)                | 30                                    |
| **Total**                                                                                                               | **89** (was 59 post-Slice-B; +30 net) |

### `resolve.spec.ts` describe-block breakdown

- **resolver layering** (6 tests) — tenant wins, platform fallthrough, default fallthrough, all-empty null, multi-tenant isolation, explicit null-default caches null.
- **cache primitives** (6 tests) — miss/hit-with-null distinction, set+get round-trip, TTL expiry, FIFO eviction at size cap, re-insertion bumps insertion order, per-tenant key isolation.
- **cache integration with resolveConfig** (5 tests) — miss → DB walk → populates; hit short-circuits stale DB; default 60s TTL; per-consumer ttl override; cache-resolved-null pattern.
- **lifecycle invalidation** (7 tests) — promote tenant invalidates; promote platform invalidates pessimistically; rollback tenant invalidates; failed promote (validation error) doesn't invalidate; failed rollback (genesis error) doesn't invalidate; non-prefixed literal namespace doesn't disturb cache; post-invalidation re-resolve repopulates.
- **dual-namespace registration** (3 tests) — both tiers register; either tier validates; idempotent re-registration.
- **schema-version pinning** (3 tests) — pinned v=N validates against schema v=N; v=2 registration coexists with v=1 row; missing schema for pinned version throws.

## Architectural framings carried to CLAUDE.md

CLAUDE.md `### Layered config resolution` subsection covers the resolver's design contract:

1. The 3-tier walk pattern (Q-NEW-F04C-1).
2. D14 nuance — `platform.<ns>` is per-tenant, NOT cross-tenant; in-code default is the genuine cross-tenant tier (Q-NEW-F04C-2).
3. Dual-namespace schema registration (Q-NEW-F04C-6).
4. Cache key translation: logical namespace cache vs literal namespace lifecycle (Q-NEW-F04C-4 + C-5).
5. Cache-resolved-null pattern (post-cache-populate consumer-registration footgun).
6. FIFO insertion-order eviction (not true LRU).
7. Post-commit invalidation placement (transaction-rollback gate).
8. Active invalidation vs TTL — single-replica vs multi-replica trade-offs.

## Forward-compat exit criteria

- **Workspace tier ship-time** — when F04 substrate adds workspace-namespace support (D14 unblock), the resolver gains `workspace.<wid>.<ns>` as the new tier 1; logical→literal stripping handler already includes `workspace.` for forward-compat. Cache key would need to include `workspace_id` (substantive change; forces cache schema bump).
- **Multi-replica cache (Redis) ship-time** — roadmap §1.12. Per-process LRU swaps to Redis-backed; active invalidation broadcasts via Pub/Sub. Resolver public API unchanged; `cache.ts` internals replaced. TTL semantics carry over identically.
- **Cross-tenant DB-driven defaults** — F04 substrate work to support NULL `tenant_id` rows (D14 unblock condition). Would let `registerConfigConsumer`'s `defaultValue` move to a DB row. Resolver public API unchanged; tier 3 reads from DB instead of in-memory map.

## Cross-feature impact

**F04 module-row state at Slice C close**: 3 / 5 slices closed (A, B, C). Slice D (impact analysis + breaking-change blocker) and Slice E (git-sync stub + module wrap-up) remain. F03 Slice C's `tenant.scd` namespace is registered via raw `registerNamespaceSchema` (not `registerConfigConsumer` — the trigger reads via raw SQL, not via `getConfig` / `resolveConfig`); migration to consumer-registration is voluntary + operator-deferred until / unless trigger reads via the resolver.

## References

- Module scope: `docs/planning/p1.4-f04-configuration-plane-scope.md` (D1-D14 + Q-NEW-F04C-1/2/3/4 surface)
- Slice A scope: `docs/planning/f04-slice-A-scope.md`
- Slice B scope: `docs/planning/f04-slice-B-scope.md`
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.4
- Source: `packages/config-plane/src/{resolve,cache,consumer-registry,lifecycle,index}.ts`
- Tests: `packages/config-plane/test/resolve.spec.ts` + reused `_utils/cleanup.ts`
- CLAUDE.md: `### Layered config resolution` (Slice C subsection under `## Configuration plane (F04)`)
- Roadmap §1.12: Redis-backed cache + Pub/Sub invalidation (multi-replica)
- Roadmap §1.13: turbo-parallel race (broadened Slice C)

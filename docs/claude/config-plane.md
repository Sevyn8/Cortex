# Configuration plane (F04)

> Relocated from CLAUDE.md for context-budget; loaded on demand.

`@cortex/config-plane` ships the tenant-facing config layer. Every tenant-scoped setting (theme tokens, i18n, feature flags, screen-registry overrides, hierarchy schema, retention policies, quality rule library, SCD policies, vertical-package selection) lives as versioned config in `tenant_config_version` with a per-namespace shape (`platform.*`, `tenant.*`, `workspace.*`).

**Storage substrate** (Slice A — landed migration 0014): row-per-`(tenant, namespace, version_number)`, append-only chain via `parent_version_id` self-FK, schema-version-pinned via `schema_version` so drafts created against v=1 keep validating against v=1 after v=2 ships. F02 provisioning seeds v=1 rows in the `tenant` namespace.

**Read API** (Slice A): `getConfig<T>(client, tenantId, namespace) → T | null`. Async; cache-hit semantics ship in Slice C. Single-namespace; layered resolution (`workspace → tenant → platform`) ships in Slice C. Schema validation against `(namespace, schema_version)` mandatory — throws `NamespaceSchemaNotRegisteredError` if no schema registered for the row's pinned version.

**Schema registry** (Slice A): `registerNamespaceSchema(namespace, schema, { version })` — call at consumer module init. **Schema version is EXPLICIT on registration**, NOT derived from package version (workspace packages stay at `0.0.0`). A namespace MAY have multiple registered schema versions simultaneously; lookup uses the row's pinned `schema_version`.

**Audit catalog** (Slice A registers; Slice B emits): 6 verbs in `packages/config-plane/src/audit-actions.ts`:

- `CONFIG_DRAFT_CREATED / UPDATED / VALIDATED / DISCARDED` — draft lifecycle (Slice B)
- `CONFIG_VERSION_PROMOTED / ROLLED_BACK` — version-chain mutations (Slice B)

**`TENANT_CONFIG_VERSION_CREATED` coexistence** (locked at Slice A HOLD #1 per Q-NEW-F04A-10): F02's existing `TENANT_CONFIG_VERSION_CREATED` (substrate-bootstrap event at v=1 provisioning) and F04 Slice B's `CONFIG_VERSION_PROMOTED` (user-driven event at lifecycle promote) coexist — different actors, triggers, contexts. Slice B does NOT deprecate the F02 event.

**Slices** (per `docs/planning/p1.4-f04-configuration-plane-scope.md`):

- A — Storage + Zod registry + read API ✓
- B — Lifecycle (draft / validate / promote / rollback) ✓ — F03 Slice C unblocks at this slice's close per D7
- C — Layered resolution + caching (in-process LRU + TTL; Redis distributed cache deferred to roadmap §1.12)
- D — Impact analysis + breaking-change blocker
- E — Git-sync stub + module wrap-up

### Lifecycle API (Slice B)

`@cortex/config-plane` ships six lifecycle helpers in `src/lifecycle.ts`. Each opens its own `db.transaction(...)` (matches F02 precedent), binds tenant context for RLS, performs the mutation, emits the appropriate audit event, and returns / throws as documented.

| Function                                | Verb   | Audit                        | Purpose                                                                                                                                                                                                                                         |
| --------------------------------------- | ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDraft(db, params)`               | CREATE | `CONFIG_DRAFT_CREATED`       | Insert active draft. Pre-checks schema registration. Substrate UNIQUE catches duplicate active draft per (tenant, namespace, author).                                                                                                           |
| `updateDraft(db, tenantId, params)`     | UPDATE | `CONFIG_DRAFT_UPDATED`       | Optimistic UPDATE on `expectedUpdatedAt`; mismatch → `DraftConcurrencyError`. Resets `validation_state` to `'unvalidated'`.                                                                                                                     |
| `validateDraft(db, tenantId, params)`   | READ   | `CONFIG_DRAFT_VALIDATED`     | Zod parse against pinned `schema_version`; persists outcome to draft row's `validation_state` + `validation_errors`. Idempotent.                                                                                                                |
| `promoteDraft(db, tenantId, params)`    | CREATE | `CONFIG_VERSION_PROMOTED`    | Defensive re-validate (Q-NEW-F04B-6); INSERT new `tenant_config_version` row with optimistic concurrency on `(tenant, namespace, version_number)` UNIQUE; UPDATE draft → `'promoted'` + `promoted_to_version_id`. Retries up to twice on 23505. |
| `rollbackVersion(db, tenantId, params)` | CREATE | `CONFIG_VERSION_ROLLED_BACK` | Whole-namespace per Q-NEW-F04B-3; INSERT new version copying parent's `config_json`; new row's `parent_version_id` points to the rolled-back-FROM version (chain integrity). Same retry-twice pattern as promote. NOT author-scoped.            |
| `discardDraft(db, tenantId, params)`    | DELETE | `CONFIG_DRAFT_DISCARDED`     | Mark `status='discarded'`. Author-only. Frees the (tenant, namespace, author) UNIQUE slot for a fresh draft.                                                                                                                                    |

**Actor parameter** (Q-NEW-F04B-8): all helpers take an `Actor` with `type ∈ {'user', 'service', 'system'}`. F02 precedent. `actor.id` becomes `created_by_user_id` for drafts (column name retained for workspace consistency; stores any actor's UUID).

**Author-only draft visibility** (D3 sub-lock pre-AC01): `updateDraft / validateDraft / discardDraft / promoteDraft` filter on `created_by_user_id = actor.id` in the SQL. Post-AC01, the RLS policy upgrades to reference `cortex.current_user_id()`; the explicit filter then becomes redundant defense-in-depth.

**Optimistic concurrency** (D13): both promote and rollback insert into `tenant_config_version`; the UNIQUE on `(tenant_id, namespace, version_number)` catches concurrent writers. Each helper retries the WHOLE transaction up to twice — Postgres aborts the transaction on first error, so retry must wrap the entire `db.transaction(...)` call (not just the INSERT). Two consecutive 23505s → `Promote-` / `RollbackConcurrencyError`. The audit row count = number of successful operations (not attempts) because the emit is post-INSERT inside the transaction; aborted attempts never emit.

**Schema-version pinning on drafts** (Q-NEW-F04B-9): `createDraft` requires explicit `schemaVersion: number`. The library exports `getLatestRegisteredVersion(namespace) → number` for callers who want "give me latest"; auto-resolving inside `createDraft` would produce a stale-validation footgun across schema-bump windows.

**Error roster** (7 classes, all suffixed `Error`, all exported from package barrel):

| Class                      | Origin                                       | Caller-decision typical                      |
| -------------------------- | -------------------------------------------- | -------------------------------------------- |
| `DraftConcurrencyError`    | optimistic UPDATE conflict on `updateDraft`  | HTTP 409; refresh + retry                    |
| `DraftNotFoundError`       | missing / not-active / wrong-author          | HTTP 404                                     |
| `SchemaNotRegisteredError` | `(namespace, schema_version)` not registered | HTTP 500 + log; consumer-module wiring issue |
| `PromoteValidationError`   | defensive re-validate failed                 | HTTP 422 (carries ZodError tree for caller)  |
| `PromoteConcurrencyError`  | both promote attempts hit 23505              | HTTP 409                                     |
| `RollbackAtGenesisError`   | latest version has no parent                 | HTTP 422                                     |
| `RollbackNoVersionError`   | no version exists for (tenant, namespace)    | HTTP 404                                     |
| `RollbackConcurrencyError` | both rollback attempts hit 23505             | HTTP 409                                     |

(`NamespaceSchemaNotRegisteredError` + `NamespaceSchemaConflictError` are sibling errors from `get-config.ts` + `schema-registry.ts`; same naming convention.)

**Test-helper precedent** (introduced Slice B): `packages/config-plane/test/_utils/cleanup.ts` exports `cleanupConfigPlaneState(pool, tenantId)` — FK-safe DELETE chain (`audit_event` → `config_draft` → `tenant_config_version`). Used by all Slice B specs. Future config-plane tests should reuse the helper rather than inline the chain.

**Cross-refs:**

- `docs/planning/p1.4-f04-configuration-plane-scope.md` (module scope; D1-D14 locks)
- `docs/planning/f04-slice-A-scope.md` (Slice A scope; sub-decision locks)
- `docs/planning/f04-slice-B-scope.md` (Slice B scope; Q-NEW-F04B-1/3/5/6/7/8/9 locks)
- `services/foundation/migrations/0014_f04_config_namespace_reshape.sql` (substrate reshape)
- `services/foundation/migrations/0015_f04_config_draft_table.sql` (config_draft table)
- `packages/canonical-schema/src/drizzle/schema.ts` (`tenantConfigVersion` + `configDraft` Drizzle definitions)
- `packages/config-plane/src/lifecycle.ts` (the 6 lifecycle helpers + 8 errors)

### Layered config resolution (Slice C)

`@cortex/config-plane` ships `resolveConfig<T>(client, tenantId, namespace) → Promise<T | null>` — the resolver walks tiers `tenant.<ns>` → `platform.<ns>` → registered in-code default; first match returns. Per-process LRU cache mediates (60s default TTL, per-consumer overridable). Lifecycle helpers (`promoteDraft`, `rollbackVersion`) actively invalidate the cache POST-commit.

**The 3-tier walk.** First non-null win:

```
resolveConfig(client, tenantId, 'theme')
  ├─ cache hit (key = tenantId :: 'theme')   → return cached value (may be null)
  ├─ getConfig(client, tenantId, 'tenant.theme')   → if non-null, cache + return
  ├─ getConfig(client, tenantId, 'platform.theme') → if non-null, cache + return
  └─ consumer.defaultValue (registered via registerConfigConsumer) → cache + return
```

`null` only when all three tiers are empty AND no consumer is registered (or consumer registered `defaultValue: null` deliberately).

**`platform.<ns>` is per-tenant, NOT cross-tenant** (D14). The `platform.*` literal namespace stores platform-shaped config as tenant-scoped rows — F04's substrate is per-tenant only; there is no cross-tenant slot. Genuine cross-tenant defaults live in-code via `registerConfigConsumer`'s `defaultValue` (the third tier). When F04 eventually ships workspace-namespace + cross-tenant substrate, in-code defaults can migrate to DB-driven without breaking consumers (the resolver's contract is tier-walk; the source of each tier is swappable).

**Dual-namespace schema registration.** `registerConfigConsumer({ namespace: 'theme', schema, schemaVersion, defaultValue })` is a thin wrapper over `registerNamespaceSchema` — registers the SAME schema under both `tenant.theme` AND `platform.theme`. Don't try to "deduplicate" by registering once: Slice B's namespace-keyed registry treats `tenant.<ns>` and `platform.<ns>` as distinct namespaces; both tiers need their own registration to validate. The consumer is the single point of truth; the registry double-records on the consumer's behalf.

**Cache key translation.** Cache is keyed on LOGICAL namespace (post-resolution; e.g., `'theme'`), but lifecycle operates on LITERAL namespace (the `tenant_config_version.namespace` column; e.g., `'tenant.theme'`). `invalidateResolverCacheForLiteralNamespace` strips the tier prefix (`tenant.` / `platform.` / `workspace.`) and invalidates the logical key. **Pessimistic invalidation**: ANY tier change invalidates the logical-key cache, even when a deeper tier wins (e.g., promoting `platform.theme` invalidates the `theme` cache entry even when `tenant.theme` exists and would dominate). Cost: occasional unnecessary re-reads. Benefit: correctness + simplicity (single cache entry per logical namespace; no per-tier slot management).

**Cache-resolved-null pattern.** `cacheGet` distinguishes miss (`undefined`) from hit-with-null (`{ value: null }`). The resolver caches `null` results to avoid repeated empty walks for namespaces with no registered consumer + no DB rows. Subtle implication: dynamic post-cache consumer registration (a `defaultValue` registered AFTER cache populated `null`) won't reflect until the entry's TTL expires or a lifecycle action invalidates it. Not a Phase 1 concern (registration is module-init), but flagged for future-proofing.

**Eviction is FIFO, not true LRU** — Map-insertion-order. True LRU would need access-time tracking. FIFO is adequate at 1000-entry / 60s TTL scale (~10 MB worst case at 10 KB/blob); when the cache fills, the oldest-inserted entries evict first. `cacheSet` deletes-and-re-sets on existing keys to bump their position (call it "insertion-order LRU bump"). Worth knowing if cache scaling ever becomes load-bearing — true LRU + access counters is a future enhancement, not a Phase 1 requirement.

**Post-commit invalidation placement.** Lifecycle invalidation fires AFTER the per-attempt transaction commits (`attemptPromote` / `attemptRollback` await `db.transaction(...)`, then call invalidate, then return). A failed transaction can't leave cache cleared without a corresponding audit row — failure throws inside the await, the invalidation line is never reached. Retry-twice path (UNIQUE-violation retry) invalidates only on the successful attempt's post-commit gate; the failed first attempt leaves cache untouched.

**Active invalidation vs TTL — single-replica vs multi-replica.** Phase 1 single-replica deploy gets exact consistency on the local replica via active invalidation + up-to-TTL consistency on remote replicas (none, in single-replica). Multi-replica deploy needs Redis-backed cache + Pub/Sub-broadcast invalidation — deferred to roadmap §1.12. Until §1.12 closes, multi-replica deploys see TTL-bounded staleness on non-mutating replicas (60s default; tunable per consumer).

**Cross-refs:**

- `docs/planning/f04-slice-C-scope.md` (Slice C scope; Q-NEW-F04C-1/2/3/4/5/6 locks)
- `packages/config-plane/src/resolve.ts` (the resolver)
- `packages/config-plane/src/cache.ts` (per-process LRU primitives)
- `packages/config-plane/src/consumer-registry.ts` (registerConfigConsumer)
- `packages/config-plane/src/lifecycle.ts` (`invalidateResolverCacheForLiteralNamespace` + the 2 post-commit call sites)
- `docs/future-roadmap.md` §1.12 (Redis migration; multi-replica path)

### Impact analysis (Slice D)

F04 Slice D ships breaking-change detection + promote-blocking for config changes. `analyzeImpact(db, tenantId, draftId)` runs against a draft pre-promote and surfaces a structured `ImpactReport` covering three orthogonal breaking-change axes:

- **`key_removed`** — a key any registered consumer cares about was removed from the config. Detected via structural JSON diff between `draft.draft_json` and the current latest version's `config_json`.
- **`schema_incompatible`** — a consumer pinned at schema v=N, but the data shape has shifted such that v=N's schema would reject it. Detected via Zod parse against the consumer's pinned schema version.
- **`policy_block`** — the consumer registered with `breakingChangePolicy: 'block'` and any keyPath of theirs was touched. Detected via consumer-keyPath × diff-path intersection.

**Override path:** callers pass `confirmBreakingChanges: true` to `promoteDraft`. Override emits a `CONFIG_VERSION_PROMOTED` audit row with enriched `after_state` metadata (`breaking_changes_overridden: true` + `affected_consumers` + `breaking_change_kinds`).

**Block path:** caller doesn't pass override; `promoteDraft` throws `ImpactBlockedError` carrying the report. `CONFIG_PROMOTE_BLOCKED` audit row emits in a SEPARATE transaction (the attempt's transaction rolled back when the throw fired; audit must survive the rollback).

### Audit-on-error in separate transaction

When auditing a REJECT-type event whose originating transaction rolled back, emit the audit in a fresh transaction. Pattern:

```ts
} catch (err) {
  if (err instanceof ImpactBlockedError) {
    // The attempt's transaction rolled back. Audit must
    // survive the rollback to record the rejection.
    await db.transaction(async (tx) => {
      await emitAuditEvent(tx, { ... });
    });
    throw err;
  }
}
```

DO NOT consolidate audit emission into the rolled-back transaction — the audit row would roll back too, defeating the purpose. This pattern applies to any REJECT-type event on a doomed transaction (current consumer: F04 Slice D's `CONFIG_PROMOTE_BLOCKED`; the load-bearing test in `impact-analysis.spec.ts` asserts the audit row exists post-rollback).

### Bidirectional path matching for impact analysis

Consumer keyPaths and diff paths match in either direction:

- Consumer registers `['theme','colors']`, diff hits `['theme','colors','primary']` → match (broader registered → narrower change).
- Consumer registers `['theme','colors','primary']`, diff hits `['theme','colors']` → match (narrower registered → broader change subsumes the specific path).

One-way matching would miss half the cases. The implementation is `pathMatchesKeyPath` in `impact-analysis.ts`; bidirectional is the contract, not an implementation detail.

### Dual catch-site behavior — two CONFIG_PROMOTE_BLOCKED rows per call on retry

`promoteDraft` can throw `ImpactBlockedError` on either the first attempt OR the retry-on-23505 second attempt (the retry path is for `PromoteConcurrencyError`, but `analyzeImpact` re-runs each attempt and may throw `ImpactBlockedError` independently). Each attempt's emission represents a real moment; auditing both is honest. Two `CONFIG_PROMOTE_BLOCKED` rows in a single user-call indicates a retry path; each row's `after_state` captures the impact at that attempt's moment (which may differ if a concurrent promote happened between attempts).

### Two-seam DB API design

- `getConfig` / `resolveConfig` retain the `Queryable` interface (narrow, single-read API) — caller passes `pg.PoolClient` or drizzle's via `withTenantContext`.
- `analyzeImpact` + lifecycle helpers use `NodePgDatabase` directly (lifecycle-shaped, transactional, multi-query API).

Two seams coexist by design. Don't speculatively unify — the surfaces have different requirements (read-narrow vs lifecycle-transactional).

### `registerConfigConsumer` vs `registerNamespaceSchema`

Two registration entry points by design:

- **`registerNamespaceSchema`** (Slice A primitive): minimal; for callers that don't need resolver/cache/impact (e.g., F03 Slice C's `tenant.scd`, where the trigger reads via raw SQL and the schema only validates draft data at promote-time).
- **`registerConfigConsumer`** (Slice C + extended Slice D): wraps `registerNamespaceSchema` + adds resolver/cache (`defaultValue`, `ttl`) + adds impact-analysis fields (`consumerModule`, `breakingChangePolicy`, `keyPaths`).

Impact analysis is OPT-IN: consumers omit `consumerModule` and they don't participate in impact reports. `registerNamespaceSchema` callers automatically don't participate. The `getImpactEligibleConsumers(namespace)` helper filters the registry to entries where `consumerModule !== undefined`.

**Cross-refs:**

- `docs/planning/f04-slice-D-scope.md` (Slice D scope; Q-NEW-F04D-1 through D-8 locks)
- `packages/config-plane/src/impact-analysis.ts` (`analyzeImpact`, `diffJson`, `pathMatchesKeyPath`)
- `packages/config-plane/src/schema-drift.ts` (`detectSchemaIncompatibilities`)
- `packages/config-plane/src/lifecycle.ts` (`emitImpactBlockedAudit` + `confirmBreakingChanges` wiring)
- `packages/config-plane/test/impact-analysis.spec.ts` (27 tests — block path's separate-transaction assertion is load-bearing)
- `docs/future-roadmap.md` §1.15 (audit_event silent-swallow workaround) and §1.16 (single-consumer-per-namespace constraint)

### Git sync stub (Slice E)

F04 Slice E ships the Configuration-as-Code Git-sync API surface as STUBS — Phase 2 deferred per build-prompt §F04 §4. `packages/config-plane/src/git-sync.ts` exports:

- `exportToYaml(ctx: GitSyncContext): Promise<string>` — Phase 2 will export every promoted `tenant_config_version` row for `ctx.tenantId` to a YAML representation suitable for committing to a per-tenant Git repository.
- `importFromYaml(ctx: GitSyncContext, yaml: string): Promise<void>` — Phase 2 will replay a YAML representation against `tenant_config_version` for `ctx.tenantId`, with each version becoming a draft → validate → promote round-trip per Slice B's lifecycle.
- `GitSyncNotImplementedError` — dedicated error class for type-narrowing in callers; `name === 'GitSyncNotImplementedError'` works in JSON-serialized contexts where `instanceof` is unreliable.
- `GitSyncContext` — the per-call context (currently `{ tenantId }`; Phase 2 widens to include Git remote URL + branch + auth material).

Both functions throw `GitSyncNotImplementedError` per Q-NEW-F04E-2 lock. Silent no-op would mask the deferral and create enterprise-customer surprise. Error messages reference roadmap §5.5 + build-prompt §F04 §4.

**Library choice deferred** per Q-NEW-F04E-3 — pinning `simple-git` / `isomorphic-git` / native `execSync` now commits to a future implementation choice prematurely; first Phase 2 consumer drives the choice.

**Async contract pinned**: stubs use `async` even though they only throw, so Phase 2 implementations can `await` consistently when the actual I/O lands. Suppressed `@typescript-eslint/require-await` lint with rationale comments.

### F04 module close

F04 module CLOSED 2026-05-10. Five slices shipped across 8 PRs over 2 days: A (storage substrate, PR #4), B (lifecycle, PR #5), C (resolver + cache, PR #8), D (impact analysis, PR #9), E (git-sync stub + module close, PR #10) — plus PR #6 closing F03 Slice C as a cross-feature pre-promote-safety inside P1.4. F04 is the **first F-module fully closed in the platform's lineage**.

Module-close commit shape per Q-NEW-F04E-5 lock: two-commit composition. Commit 1 `feat(F04-E): git-sync stub` lands the slice (source + tests + slice scope doc). Commit 2 `feat(F04): configuration plane` lands the symbolic module-close summary (gate evidence, status flip, roadmap backref, this CLAUDE.md subsection). Sets the precedent for all future module-close commits in the codebase — F02 didn't land its `feat(F02): tenant lifecycle manager` close commit yet, so F04 establishes the pattern.

**Gate evidence:** `docs/planning/f04-gate-evidence.md` captures build-prompt acceptance × evidence; D1-D14 module locks honored across all 5 slices; per-slice phase summary; cross-feature impact (F03 module status + downstream queue); PASS-by-construction note for the sub-10ms p99 acceptance criterion.

**Downstream queue unblocked:** P1.5 F05 Schema Evolution; P1.6 Feature Flags (`@cortex/feature-flags` is the named first consumer per D6); D04 quality rule library; UX01 theme tokens; IC01 vertical-package selection; IC02 i18n + locale; AC02 hierarchy schema; PR06 retention policies. Each becomes operator-selectable post-merge.

**F03 module-row remains unchecked.** F03 Slice C closed inside P1.4 (PR #6); F03 Slice D ("Late-arriving data") remains DEFERRED (blocked by D04 + S01 + SCR-08). F03's full module close lags F04's — readers shouldn't expect F03 ✓ to follow F04 ✓ in `status.md`.

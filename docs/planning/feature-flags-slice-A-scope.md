# P1.6 Slice A — Core surface (server-side)

> Cross-ref: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice A.
>
> Populated 2026-05-10 at HOLD #3 close. Slice A ships the `@cortex/feature-flags` workspace package + flag-definition Zod schemas (3-discriminated-union: boolean / variant / percentage) + server-side `isEnabled` / `getVariant` APIs over a per-key tier-walk merge + percentage rollout via SHA-256 + 4 initial named flags from build-prompt.

## §1 Slice goal

Land the server-side surface P1.6 Slices B + C build on. Establish the F04 consumption pattern P1.6 will use across all 3 slices: `registerConfigConsumer` adoption (resolver-cache-aware path) + per-key tier-walk merge + own per-process LRU. Acceptance criterion 1 (30s propagation) achieved via TTL=30s on both F04 consumer and P1.6's own cache.

## §2 Phase plan + actuals

| Phase       | Scope                                                                                                                                              | Estimate | Actual                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A.1**     | Package skeleton (`package.json`, tsconfigs, vitest config)                                                                                        | 0.5 hr   | 0.4 hr                                                                                                                                                |
| **A.2-A.3** | Zod schemas (3 discriminated-union flag types + record namespace) + `registerConfigConsumer` adoption helper + `assertVariantConsistent` invariant | 0.75 hr  | 0.5 hr                                                                                                                                                |
| **A.4**     | `rollout.ts` SHA-256 percentage-bucket helper (`node:crypto`)                                                                                      | 0.5 hr   | 0.4 hr                                                                                                                                                |
| **A.5**     | `eval.ts` (load-bearing) — `isEnabled` + `getVariant` with per-key tier-walk merge + `cache.ts` per-process LRU TTL=30s                            | 1 hr     | 1 hr                                                                                                                                                  |
| **A.6**     | `initial-flags.ts` — 4 named build-prompt flags + eager top-level registration + barrel                                                            | 0.25 hr  | 0.25 hr                                                                                                                                               |
| **A.7**     | 4 spec files (rollout / registration / initial-flags / eval); 45 tests; F04-substrate integration via `withTenantContext`                          | 1-1.5 hr | 1.5 hr (incl. TS-quirk fix on `withTenantContext` lambda inference + Queryable barrel addition + roadmap §1.18 + slice-doc populate + CLAUDE.md note) |
| **Total**   |                                                                                                                                                    | 4-4.5 hr | **~4 hr**                                                                                                                                             |

Lower than the upper-bound estimate because Q-NEW-FF-A-6's per-key tier-walk implementation compressed to ~25 LOC (close to but slightly under the 30 LOC estimate).

## §3 Q-NEW-FF-A locks (final)

| ID               | Lock                                                                                                                                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-FF-A-1** | 3-discriminated-union schemas (BooleanFlag / VariantFlag / PercentageFlag) discriminated on `type`; namespace shape = `z.record(z.string(), FlagDefinitionSchema)`                                                                                                                                                | Mirrors F03 Slice C `SCDEntityPolicySchema` precedent. Cross-field invariant (`variants` includes `default`) extracted to `assertVariantConsistent` helper because `.refine()` produces `ZodEffects` which `z.discriminatedUnion` rejects.    |
| **Q-NEW-FF-A-2** | SHA-256(`${userId}:${flagKey}`) → first 4 bytes uint32 → mod 100 → bucket [0, 99]; absent userId returns flag default (no rollout participation)                                                                                                                                                                  | Deterministic, no salt (would break determinism across deployments), no tenant_id input (flags don't cross tenants). First crypto-hash consumer in workspace src.                                                                             |
| **Q-NEW-FF-A-3** | Hybrid signature `(client: Queryable, tenantId: string, params: { flagKey, userId? })` matching F04 `promoteDraft` precedent                                                                                                                                                                                      | Workspace pattern is hybrid (positional db + tenantId, params object); pure object args was the operator's lean but the precedent was hybrid.                                                                                                 |
| **Q-NEW-FF-A-4** | **HOLD #1 OVERRIDE.** Eager top-level registration at import time (matches F03 Slice C `scd-policy.ts:177` precedent + `audit-actions` pattern). Operator's initial lean was option (c) explicit caller-driven; HOLD #1 investigation surfaced workspace existing pattern is (a) eager. Workspace precedent wins. | Two valid patterns coexist; eager-at-import is the established workspace shape. Convenience helper `registerInitialFeatureFlags()` exported for tests that call `resetConsumerRegistry()`.                                                    |
| **Q-NEW-FF-A-5** | Real F04 substrate via `@cortex/test-db-harness`. Tests register custom flag-sets via `registerFeatureFlagsConsumer` + INSERT tier rows via `pgPool` (bypassing F04 lifecycle for fixture-setup speed).                                                                                                           | F04 is shipped + 121-test-stable; mocking adds maintenance burden; integration coverage is more valuable.                                                                                                                                     |
| **Q-NEW-FF-A-6** | Per-key tier-walk in `eval.ts` (load-bearing): tenant > platform > consumer-default; missing flags → `false` from `isEnabled` / `null` from `getVariant`. P1.6 ships its own per-process LRU TTL=30s mirroring F04 `cache.ts` (~30 LOC); `roadmap §1.18` captures the abstraction trigger for future extraction.  | F04's `resolveConfig` returns FIRST non-null tier's whole-namespace JSON — no per-key merging. P1.6 needs per-key precedence; uses raw `getConfig` reads + own merge + own cache. **Architectural finding** documented in §6 below + roadmap. |

## §4 File surface (12 files in @cortex/feature-flags + 4 ancillary)

**Package files (12):**

```
packages/feature-flags/
├── package.json                            (deps: @cortex/config-plane runtime; canonical-schema + test-db-harness devDeps)
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── src/
│   ├── index.ts                            (barrel; eager side-effect import of initial-flags)
│   ├── registration.ts                     (3 Zod schemas + namespace record + consumer-registration helper + assertVariantConsistent)
│   ├── rollout.ts                          (SHA-256 percentage-bucket helper)
│   ├── eval.ts                             (isEnabled + getVariant with per-key tier-walk)
│   ├── cache.ts                            (per-process LRU TTL=30s mirroring F04 cache.ts)
│   └── initial-flags.ts                    (4 build-prompt flags + eager registration + registerInitialFeatureFlags helper)
└── test/
    ├── rollout.spec.ts                     (7 specs)
    ├── registration.spec.ts                (14 specs)
    ├── initial-flags.spec.ts               (7 specs)
    └── eval.spec.ts                        (17 specs; load-bearing integration)
```

**Ancillary changes (this commit's bundle):**

- `packages/config-plane/src/index.ts` — `Queryable` type re-export from F04 barrel (consistent "import everything F04-shaped from `@cortex/config-plane`" pattern).
- `pnpm-lock.yaml` — auto-updated for new package's deps.
- `CLAUDE.md` — TypeScript inference threshold note added under DB-conventions RLS-testing section (Q-NEW-FF-A-6 finding for future similar packages).
- `docs/planning/feature-flags-slice-A-scope.md` — this file populated from shell.

## §5 Test count delta

**0 → 45 specs** (+45 net for `@cortex/feature-flags`).

| Spec file               | Tests | Coverage                                                                                                                                                                    |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rollout.spec.ts`       | 7     | bucket range, determinism, independence, distribution, edge cases (empty userId/flagKey)                                                                                    |
| `registration.spec.ts`  | 14    | per-type schema validation, discriminated-union dispatch, namespace record, `assertVariantConsistent` invariant, consumer registration shape                                |
| `initial-flags.spec.ts` | 7     | 4 named flags + types + variant invariant + eager registration                                                                                                              |
| `eval.spec.ts`          | 17    | per-key tier-walk (5), per-flag-type evaluation (boolean / variant / percentage; 9), cache + multi-tenant isolation (2), unknown-flag fallback, anonymous-userId percentage |

Workspace regression: `@cortex/config-plane` 121/121 stable; `@cortex/foundation` 84/84 stable; workspace typecheck across 31 packages (+1 from feature-flags) clean.

## §6 Lessons during build

### A-4 override — workspace precedence over operator lean

Operator's HOLD #1 lean was option (c) explicit caller-driven registration. HOLD #1 investigation surfaced the workspace's existing precedent (F03 Slice C `scd-policy.ts:177` + `audit-actions.ts`) is option (a) eager top-level side effect at module import. Workspace precedent wins. Convenience helper `registerInitialFeatureFlags()` exported for tests that need to re-register after `resetConsumerRegistry()` clears module-level state. **Pattern note**: when operator's lean conflicts with established workspace pattern, surface the conflict at HOLD #1 and override the lean toward the workspace precedent. Avoids future-developer confusion about "why does THIS module do it differently."

### A-6 per-key tier-walk gap (load-bearing)

F04 Slice C's `resolveConfig` returns the FIRST non-null tier's whole-namespace JSON — no per-key merging. For P1.6's `feature-flags` namespace (a record keyed by flag-key), this means `resolveConfig` would return only the tenant tier's flags if any exist, hiding platform-tier flags + consumer defaults entirely. **Result**: P1.6 ships its own per-key tier-walk in `eval.ts` (uses raw `getConfig` reads on each tier, then per-key precedence merge) + own per-process LRU mirroring F04 `cache.ts` (~25 LOC + ~85 LOC respectively). Roadmap §1.18 captures the abstraction trigger: when a SECOND consumer adopts record-shaped namespaces with per-key tier precedence (likely UX01 or IC02 in Phase 2), extract the merge into `@cortex/config-plane` as `resolveRecordConfig`.

### TS-inference threshold on `withTenantContext` lambda

`test/eval.spec.ts` has 21 `withTenantContext(testPool, tenantId, (tx) => isEnabled(tx, ...))` call sites. After ~14 successful inferences, TypeScript fell back to `any` for the `tx` parameter on the remaining 5+ lambdas — same syntactic pattern, but the cumulative complexity exceeded TS's inference budget. Workaround: explicit `(tx: PoolClient) => ...` annotation on all 21 sites. Imported `PoolClient` from `pg`. F04's `resolve.spec.ts` doesn't hit this — likely because the file is shorter / less type-heavy. **Pattern note** captured in CLAUDE.md `## Database conventions ### Testing RLS-protected tables` for future similar packages.

## §7 Cross-references

- Module scope: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice A + §3 (D1 namespace = `feature-flags`; D2 flag types; D3 server API shape; D5 audit deviation = no per-evaluation audit; D6 default-value strategy; D7 percentage rollout via SHA-256; D8 Phase 2 boundary).
- F04 surfaces consumed: `getConfig`, `getConfigConsumer`, `registerConfigConsumer`, `Queryable` (newly re-exported from F04 barrel) — all from `@cortex/config-plane`.
- Live consumer pattern reference: `packages/temporal-query/src/scd-policy.ts:177` (eager-at-import precedent F03 Slice C established; P1.6 Slice A's Q-NEW-FF-A-4 lock honors).
- F04 cache pattern reference: `packages/config-plane/src/cache.ts` (P1.6's `cache.ts` mirrors the Map-based LRU + TTL eviction shape; differs in cache key — F04 keys on `(tenantId, namespace)`, P1.6 keys on `tenantId` alone since the value IS the merged record).
- Build-prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.6 lines 1223-1224 (flag-definition shape; `flag.isEnabled(tenantId, userId)` signature).
- Roadmap §1.18 (per-key tier-walk abstraction trigger; Q-NEW-FF-A-6 lock surfaced this).
- CLAUDE.md `### Testing RLS-protected tables` (TS-inference threshold note from Q-NEW-FF-A-7 work).

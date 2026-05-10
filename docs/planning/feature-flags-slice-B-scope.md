# P1.6 Slice B — HTTP endpoint + client shim

> Cross-ref: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice B.
>
> Populated 2026-05-10 at HOLD #3 close. Slice B ships the **HTTP transport** + **non-React client shim** per Q-NEW-FF-B-1 lock (e). New `apps/feature-flags-api/` Hono service serves `GET /v1/feature-flags?userId=...` (bulk fetch). New `packages/feature-flags/src/client.ts` wraps the endpoint with state management + diff-based subscription + 30s polling.

## §1 Slice goal

End-to-end feature-flags consumption demoable at module close. Slice C consumes the endpoint for the admin UI stub; SCR-04 wires React + production deployment in Phase 2.

`apps/feature-flags-api/` is the **second apps-level Hono service** in the workspace (first was `tenant-lifecycle-api` shipped in F02 Slice D). Per-module-HTTP-service pattern is NOT yet formalized — architectural review deferred to N=3.

## §2 Phase plan + actuals

| Phase     | Scope                                                                                                                                                                                                                    | Estimate | Actual                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------- |
| **B.1**   | `apps/feature-flags-api/` skeleton — package.json, tsconfigs, vitest config, app factory mirroring `tenant-lifecycle-api` shape (minimal: middleware + routes + error-mapper; no observability SDK / Cloud SQL IAM auth) | 0.75 hr  | 0.5 hr                                                     |
| **B.2**   | `routes/v1/feature-flags.ts` — `GET /v1/feature-flags` with bulk evaluation; `evaluateAllFlags` helper added to `@cortex/feature-flags` `eval.ts`; tenant-context middleware bound; Zod query-param validation           | 0.75 hr  | 0.75 hr                                                    |
| **B.3**   | `packages/feature-flags/src/client.ts` — `createFeatureFlagsClient` with state mgmt + HTTP fetch + tenant header                                                                                                         | 0.75 hr  | 0.5 hr                                                     |
| **B.4**   | Polling at 30s (configurable `pollIntervalMs`) + diff-based notification + dispose                                                                                                                                       | 0.5 hr   | 0.4 hr                                                     |
| **B.5**   | Tests — route integration (7 specs) + client unit tests with fake timers (16 specs)                                                                                                                                      | 1-1.5 hr | 1.25 hr (incl. 4 lint-fix iterations + 2 test-shape fixes) |
| **B.6**   | Slice scope doc populate; workspace regression check                                                                                                                                                                     | 0.25 hr  | 0.25 hr                                                    |
| **Total** |                                                                                                                                                                                                                          | 4-4.5 hr | **~3.65 hr**                                               |

Compressed under estimate because the Hono app skeleton was minimal (no Cloud SQL IAM auth or observability SDK init like `tenant-lifecycle-api` ships) — production deployment hardening is a Phase 2 concern.

## §3 Q-NEW-FF-B locks (final)

| ID               | Lock                                                                                                                 | Rationale                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q-NEW-FF-B-1** | (e) HTTP endpoint in Slice B; admin UI in Slice C                                                                    | Operator's HOLD #1 lock. `apps/feature-flags-api/` is the second apps-level Hono service in the workspace; architectural review for per-module-HTTP-service pattern deferred to N=3. Module-total ~9-9.5 hr (slightly above 6-9 hr estimate; accepts overrun for end-to-end demo coherence). |
| **Q-NEW-FF-B-2** | Bulk fetch — `GET /v1/feature-flags?userId=<userId>` returns `{ flags: { [flagKey]: { type, value } } }`             | Single round-trip on app load; matches client polling pattern; admin UI consumption-friendly.                                                                                                                                                                                                |
| **Q-NEW-FF-B-3** | Trust-the-header auth — `x-cortex-tenant-id` required; AC01 enforcement deferred to P2.1                             | Marked with `// TODO(AC01)` in `app.ts`. Phase 2 swaps `rejectMissingTenant: true` middleware for AC01 role-checking middleware. Internal-only Phase 1 surface.                                                                                                                              |
| **Q-NEW-FF-B-4** | Polling at 30s default interval; `pollIntervalMs` option for fast tests; `refresh()` API exposed for explicit-bypass | Matches Slice A's TTL=30s + criterion 1's 30s propagation. SSE deferred to Phase 2. Polling errors swallowed (transient network blip doesn't crash host).                                                                                                                                    |
| **Q-NEW-FF-B-5** | Convention doc lands in Slice C (consolidated with module-close docs work)                                           | Slice B focused on code; Slice C consolidates `docs/architecture/feature-flags.md` with lifecycle conventions + audit deviation rationale + module-close.                                                                                                                                    |

## §4 File surface

**New files (apps/feature-flags-api/, 7 files):**

```
apps/feature-flags-api/
├── package.json                            (deps: @cortex/feature-flags + @cortex/tenant-context + Hono + @hono/zod-validator + hono-problem-details)
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── src/
│   ├── app.ts                              (Hono app factory; tenant-context middleware; route registration; problem-details handler)
│   ├── error-mapper.ts                     (TenantValidationError + TenantContextMissingError → 400 problem-details)
│   └── routes/
│       └── v1/
│           └── feature-flags.ts            (GET handler + runWithBoundTenantClient transaction helper)
└── test/
    └── routes/
        └── v1/
            └── feature-flags.spec.ts       (7 specs)
```

**New files (packages/feature-flags/, 2 files):**

- `packages/feature-flags/src/client.ts` (NEW; ~225 lines — `createFeatureFlagsClient` + state mgmt + polling + diff-notify)
- `packages/feature-flags/test/client.spec.ts` (NEW; 16 specs)

**Modified files:**

- `packages/feature-flags/src/eval.ts` — added `evaluateAllFlags(client, tenantId, userId?)` bulk-fetch primitive + `FlagEvaluation` discriminated-union type.
- `packages/feature-flags/src/index.ts` — barrel exports for `evaluateAllFlags`, `FlagEvaluation`, `createFeatureFlagsClient`, `FeatureFlagsClient`, `FeatureFlagsClientOptions`, `FlagSubscriber`.

## §5 Test count delta

**45 → 61** specs in `@cortex/feature-flags` (+16 net for `client.spec.ts`).
**0 → 7** specs in `@cortex/feature-flags-api` (NEW package).
**Total +23 net** for Slice B.

| Spec file                                                     | Tests | Coverage                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/feature-flags/test/client.spec.ts`                  | 16    | refresh / cache / subscribe / unsubscribe / diff-based notification / polling with fake timers / dispose / invalidate / removed-flag handling / subscriber-throw isolation / malformed response / non-2xx / userId query param |
| `apps/feature-flags-api/test/routes/v1/feature-flags.spec.ts` | 7     | bulk fetch returns 4 initial flags / per-type evaluation / missing-header → 400 / userId query param / tenant override > consumer default / multi-tenant isolation / health route                                              |

Workspace regression: `@cortex/feature-flags` 61/61; `@cortex/feature-flags-api` 7/7; `@cortex/config-plane` 121/121 stable; `@cortex/foundation` 84/84 stable; workspace typecheck across **33 packages** (+1 from feature-flags-api → 33 vs 32 from Slice A) clean.

## §6 Lessons during build

### Tenant-context error class — `TenantValidationError`, not `TenantContextMissingError`

The middleware throws `TenantValidationError` when `x-cortex-tenant-id` header is missing AND `rejectMissingTenant: true`. `TenantContextMissingError` is for a different case (caller reads `getTenantId()` outside the bound async-local context). Initial error-mapper handled only `TenantContextMissingError` → tests reported 500 instead of 400 → fixed by adding `TenantValidationError` mapping.

### Hono `app.use('*', tenantMw.hono)` triggers `unbound-method` lint

Detached method reference loses `this` binding. Workaround: `app.use('*', tenantMw.hono.bind(tenantMw))`. Pattern note: any Hono middleware exposed as a method on an object instance needs `.bind()` when registered.

### `runWithBoundTenantClient` inlined in route — extraction trigger at N=2 service

Manual transaction + `set_config('app.tenant_id')` pattern inlined in `feature-flags.ts` route. The Queryable seam (`PoolClient.query(sql, params)`) matches `@cortex/feature-flags`'s `evaluateAllFlags`; drizzle's tx (used by F02's `withTenantDbClient`) doesn't structurally satisfy Queryable. **Extraction trigger:** if a second app-level service needs the same pattern, extract `runWithBoundTenantClient` to `@cortex/tenant-context` as a production-named sibling of the test-only `withTenantContext` (currently exported from `@cortex/canonical-schema/rls-test`).

### Architectural review at N=3 apps-level Hono service

`apps/feature-flags-api/` is N=2; `tenant-lifecycle-api` is N=1. Per Slice B HOLD #1: **per-module-HTTP-service pattern is NOT yet formalized**. When N=3 (likely D04 admin endpoints, AC01 RBAC routes, or similar), revisit:

- Should small HTTP services consolidate into a single multi-router service? (gateway pattern)
- Should each module ship its own apps directory? (per-bounded-context pattern)
- Cloud Run resource economics — N small services vs 1 multi-router

NOT a roadmap entry yet (no concrete decision needed); flagged here as future-architectural-review trigger condition.

### Test environment has global fetch — defensive `no fetch` throw is unreachable

`createFeatureFlagsClient` throws if both `opts.fetch` and `globalThis.fetch` are undefined. Modern Node 22 + browser test environments always have global fetch; the throw is defensive for older Node / custom transport-shimming runtimes. Test that asserted the throw was DELETED (unreachable in our test environment); the throw remains in the source as a defensive guard.

### `exactOptionalPropertyTypes: true` rejects `init: undefined` in test fixture

vitest's `RequestInit` parameter is typed `init?: RequestInit` — passing `init: undefined` to a `{ init?: RequestInit }` interface is rejected under `exactOptionalPropertyTypes`. Workaround: conditional spread `...(init !== undefined && { init })`. Same workspace-wide convention as F04 Slice D's actor-description handling.

## §7 Cross-references

- Module scope: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice B + §3 (D1 namespace, D3 server API shape, D8 Phase 2 boundary).
- Slice A (consumed): `packages/feature-flags/src/eval.ts` exports `evaluateAllFlags` (Slice B added) which the route handler consumes.
- F04 surfaces consumed: `getConfig` (per-tier read in `eval.ts`'s `resolveAllFlags`).
- F02 precedent for Hono app shape: `apps/tenant-lifecycle-api/` (middleware composition, route factory pattern, error-mapper shape).
- ADR-HTTP-001: Hono framework choice; applies here.
- CLAUDE.md `### apps/<workload>-api/` — codified per-workload-app shape; Slice B's `feature-flags-api` matches the convention modulo full-deployment hardening (Cloud SQL IAM auth + observability SDK + Dockerfile deferred to Phase 2 deployment readiness).
- Build-prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.6 line 1224 — `flag.isEnabled(tenantId, userId)` signature aligns with the route's `userId?` query param.

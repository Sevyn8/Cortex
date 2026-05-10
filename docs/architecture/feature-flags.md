# Feature flags convention

> P1.6 Feature Flags conventions per build-prompt §P1.6 (line 1229 directive). Lifecycle, audit semantics, registration patterns, Phase 2 deferrals.
>
> Filename `feature-flags.md` literal per build-prompt; deviates from workspace `<concept>-convention.md` pattern (codified in CLAUDE.md `## Coding conventions`).

## §1 What feature flags are

Feature flags gate runtime behavior on a `(tenant, flag)` (and optionally `(tenant, flag, user)`) basis. They are the substrate behind the workspace-wide directive at build-prompt §399 + CLAUDE.md line 740: **"All new capabilities roll out behind a feature flag (`@cortex/feature-flags`)"**.

P1.6 ships flags as a thin consumer of F04 Configuration Plane:

- **Storage:** F04's `tenant_config_version` table under namespace `feature-flags` (tier-prefixed `tenant.feature-flags` and `platform.feature-flags`); registered at consumer-init via `registerConfigConsumer` per F04 D6 lock + Q-NEW-FF-A-3.
- **Evaluation:** `@cortex/feature-flags` package — `isEnabled` / `getVariant` / `evaluateAllFlags` (server) + `createFeatureFlagsClient` (HTTP-backed client shim).
- **Transport:** `apps/feature-flags-api` — Hono `GET /v1/feature-flags?userId=…` bulk fetch.

Three flag types per Q-NEW-FF-A-1: `boolean`, `variant`, `percentage`. Discriminated union by `type` field; namespace-level shape is `Record<flagKey, FlagDefinition>`.

## §2 Flag lifecycle

Three states per build-prompt §P1.6 line 1231-1232:

- **`experimental`** — newly registered; gated to a small audience or specific tenant set; expected to be promoted to `stable` or retired within 6 months.
- **`stable`** — promoted to general availability; default state for tenant rollouts; can stay indefinitely as long as the underlying capability is supported.
- **`retired`** — capability has been replaced or removed; flag is scheduled for deletion. **Code referencing a `retired` flag must be cleaned up** (the `if (isEnabled(...))` branches removed) before the flag is deleted from `INITIAL_FLAGS` or any tenant override.

**Six-month renewal rule** (build-prompt §P1.6 line 1232): no flag older than 6 months stays in the `experimental` state without explicit renewal. Operator review triggers at the 6-month mark — promote to `stable`, retire, or document a renewal rationale in the flag's `description` field.

Phase 1 lifecycle state is **NOT a Zod-schema field** — it's tracked operationally via the flag's description. Phase 2 may add a `lifecycle` field to `FlagDefinitionSchema` if drift becomes load-bearing.

## §3 Server-side API

**`isEnabled(client, tenantId, params: { flagKey, userId? }): Promise<boolean>`** — boolean evaluation. Boolean flags return `default`. Percentage flags return `!default` for users in the rollout bucket; `default` for anonymous calls. Variant flags return `false` (callers should use `getVariant`).

**`getVariant(client, tenantId, params: { flagKey, userId? }): Promise<string | null>`** — variant evaluation. Returns the configured `default` for variant flags; returns `null` for unknown flags or non-variant types. Phase 1 ships ALL users to the configured default — per-user variant assignment defers to Phase 2 attribute-based targeting (requires AC01 user-attribute substrate).

**`evaluateAllFlags(client, tenantId, userId?): Promise<Record<string, FlagEvaluation>>`** — bulk-fetch primitive used by `apps/feature-flags-api`'s `GET /v1/feature-flags` endpoint. Single round-trip through `resolveAllFlags` (cached per-tenant TTL=30s); per-flag evaluation is in-memory after the merged record loads.

All three take a `Queryable` (raw `pg.PoolClient` or compatible) and require pre-bound RLS tenant context — see `runWithBoundTenantClient` precedent in `apps/feature-flags-api/src/routes/v1/feature-flags.ts` (extraction trigger captured at roadmap §1.19).

## §4 Client-side API + React hook recipe

**`createFeatureFlagsClient({ baseUrl, tenantId, userId?, fetch?, pollIntervalMs? }): FeatureFlagsClient`** — non-React shim that wraps the HTTP endpoint with state management, polling, and diff-based subscription.

API surface:

- `getCachedValue(flagKey)` — read cached snapshot.
- `subscribe(flagKey, callback) → unsubscribe` — fires only when the flag's value changes between polls.
- `refresh()` — explicit re-fetch (bypasses polling timer).
- `invalidate()` — clear cache.
- `dispose()` — stop polling timer + clear subscribers.

Defaults: `pollIntervalMs = 30_000` (matches Slice A TTL=30s + criterion 1's 30s propagation). `fetch` falls back to `globalThis.fetch`.

**React hook recipe** (Phase 1 ships the shim, NOT the hook — React infrastructure ADR lands at SCR-04 ship in Phase 2):

```tsx
import { useEffect, useState } from 'react';
import { createFeatureFlagsClient, type FlagEvaluation } from '@cortex/feature-flags';

const client = createFeatureFlagsClient({
  baseUrl: import.meta.env.VITE_FEATURE_FLAGS_API_URL,
  tenantId: getCurrentTenantId(),
  userId: getCurrentUserId(),
});

void client.refresh(); // populate cache on app load

export function useFeatureFlag(flagKey: string): FlagEvaluation | undefined {
  const [value, setValue] = useState(() => client.getCachedValue(flagKey));
  useEffect(() => {
    const unsubscribe = client.subscribe(flagKey, setValue);
    return unsubscribe;
  }, [flagKey]);
  return value;
}
```

Caller:

```tsx
const flag = useFeatureFlag('agents.planogram.v2-model');
if (flag?.type === 'variant' && flag.value === 'v2') {
  // render challenger UI
}
```

SCR-04 will ship a production `useFeatureFlag` hook; the recipe above is illustrative for Phase 1 callers who need React integration before SCR-04 lands.

## §5 Audit semantics

**Per-flag-CHANGE audit only.** Flag mutations go through F04's `promoteDraft` lifecycle on the `tenant.feature-flags` namespace; F04 emits `CONFIG_VERSION_PROMOTED` for every promote — that audit row IS the per-flag-change record. P1.6 does NOT add new audit verbs.

**DEVIATION from build-prompt directive** at §P1.6 line 1233: "All flag evaluations logged for auditability via audit events" is **untenable at scale** — `isEnabled` is a hot-path read, often called thousands of times per second per service. Per-evaluation audit would dwarf F04's audit volume by orders of magnitude.

**Recommended interpretation honored in Phase 1:** auditability of CHANGES (which F04 lifecycle provides for free) satisfies the spirit of the directive. The build-prompt's wording is preserved in the docs for traceability.

**Per-session-first-evaluation audit deferred** as a Phase 2 enhancement IF observability requirements surface (e.g., compliance auditors need "first time tenant X saw flag Y"). Trigger condition is tracked operationally; not a roadmap entry yet.

This deviation is locked at Q-NEW-FF-A-5 (Slice A) + Q-NEW-FF-D-5 (module scope D5).

## §6 Adding new flags

New flags register at consumer-module init via top-level side-effect import (Q-NEW-FF-A-4 lock — eager-at-import precedent matches F03 Slice C `scd-policy.ts:177` + audit-actions pattern).

**Path 1 — extending the 4 build-prompt flags.** Add the flag definition to `INITIAL_FLAGS` in `packages/feature-flags/src/initial-flags.ts`. The eager `registerInitialFeatureFlags()` call picks it up on next module import.

**Path 2 — separate consumer module registration.** Future Phase 2 consumers can call `registerFeatureFlagsConsumer(customFlags)` with their own flag set. The registry's underlying `Map` is keyed on namespace alone (per roadmap §1.16) — Phase 1 single-consumer-per-namespace constraint applies; multi-consumer-per-namespace defers to N≥2 trigger.

**Path 3 — runtime flag changes.** Operators promote flag changes via F04's `promoteDraft` on the `tenant.feature-flags` namespace. Lifecycle's audit + impact-analysis primitives apply. No P1.6-specific tooling required; F04's surface IS the runtime mutation API.

**Naming convention.** Flag keys use dotted-namespace convention: `<domain>.<feature>` or `<domain>.<feature>.<version>`. Examples from build-prompt:

- `admin-console.display-data-workspace-switcher` (gradual rollout)
- `analytical.cx-dd-01-beta`
- `agents.planogram.v2-model`
- `ingestion.csv-agent-v2`

No regex enforcement at the substrate level — keys are caller-chosen — but the dotted-domain pattern is the workspace convention.

## §7 Phase 2 deferrals

Per Q-NEW-FF-D-8 module-scope lock + per-slice deferrals:

- **Full interactive Admin UI** — SCR-04 Configuration screen replaces P1.6 Slice C's static HTML stub. React + bundler + mutation routes (toggle / promote / rollback). React-infrastructure ADR-FE-001 lands at SCR-04 ship.
- **Attribute-based targeting** — per-user attributes other than rollout `%`. Requires AC01's user-attribute substrate (P2.1 unshipped). Variant flag's per-user assignment also defers here.
- **Multi-replica cache invalidation broadcast** — roadmap §1.12 (Redis-backed distributed cache + Pub/Sub-broadcast invalidation). Phase 1 single-replica deploys get exact consistency on the local replica + up-to-TTL staleness on remote replicas (none in single-replica).
- **Per-evaluation audit emission** — §5 deviation rationale.
- **Per-flag TTL override** — namespace-level `ttl=30` governs all flags in Phase 1. Per-flag overrides land if a high-throughput flag needs different cadence.
- **SSE for client subscription** — replaces polling at sub-second propagation. Needs server-side event broadcast wired to F04 lifecycle invalidation.
- **AC01 auth wire-up on `apps/feature-flags-api`** — Phase 1 trust-the-header at `x-cortex-tenant-id` (Q-NEW-FF-B-3 lock; `// TODO(AC01)` marker in `app.ts`). When AC01 (P2.1) ships, swap `rejectMissingTenant: true` middleware for AC01 role-checking middleware.
- **Multi-consumer-per-namespace registry** — roadmap §1.16. First consumer hitting the constraint triggers extraction.

Migration path is additive — Phase 1 surface stays stable; only new APIs land.

## §8 Cross-references

**Build-prompt:**

- `docs/build-prompts/cortex_build_prompts_v3.md` §P1.6 (lines 1211-1248) — canonical scope.
- `docs/build-prompts/cortex_build_prompts_v3.md` line 399 — workspace-wide flag-rollout rule (CLAUDE.md mirror at line 740).
- `docs/build-prompts/cortex_build_prompts_v3.md` line 3316 — A02 champion/challenger consumer of `agents.planogram.v2-model`.

**ADRs:**

- ADR-DB-002 (RLS) — flag definitions are tenant-scoped via F04's `tenant_config_version`.
- ADR-DB-003 (audit chain) — `CONFIG_VERSION_PROMOTED` preserves chain integrity for flag changes.
- ADR-AU-001 (audit-events library) — F04 owns the catalog; P1.6 reuses (no new verbs per §5 deviation).
- ADR-HTTP-001 (Hono) — `apps/feature-flags-api` follows the framework choice.

**Module-scope + slice scopes:**

- `docs/planning/p1.6-feature-flags-scope.md` (D1-D8 locks + Q-NEW-FF-A/B/C surface).
- `docs/planning/feature-flags-slice-A-scope.md` (server-side core + Q-NEW-FF-A locks).
- `docs/planning/feature-flags-slice-B-scope.md` (HTTP endpoint + client shim + Q-NEW-FF-B locks).
- `docs/planning/feature-flags-slice-C-scope.md` (admin UI stub + module wrap-up + Q-NEW-FF-C locks).
- `docs/planning/feature-flags-gate-evidence.md` (module gate evidence at close).

**Roadmap entries surfaced during P1.6:**

- §1.18 — per-key tier-walk abstraction trigger (Slice A finding).
- §1.19 — `runWithBoundTenantClient` extraction trigger (Slice B finding).

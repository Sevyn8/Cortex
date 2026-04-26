# F02 Swap Paths for Slice C Resolvers

**Status:** Active — describes Phase 1 → F02 evolution path
**Authored:** 2026-04-26 (F01 Slice C sub-phase 7)
**Companion documents:** ADR-INFRA-007 (precedent: substrate-now /
real-impl-later for KMS keys), ADR-COMPUTE-001 (compute placement
model), `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`

Purpose: catalog the two Phase 1 stub resolvers shipped by Slice C
and their planned F02 evolution. The swap is purely additive — same
API surface, different runtime behavior. Same pattern as
ADR-INFRA-007's substrate-now / real-impl-later contract for KMS
keys.

## Context

Slice C ships two resolvers as Phase 1 stubs because their
downstream consumer (tenant lifecycle automation, F02) hasn't
shipped yet:

1. **`getQuotaConfig(tier, resourceClass)`** from `@cortex/quotas` —
   returns hardcoded per-tier defaults from `DEFAULT_TIER_QUOTAS`.
   F02 will read per-tenant config from
   `tenant_config_version.config_json.quotas[resource_class]` with
   fallback to the table.

2. **`getComputePlacement(params)`** from `@cortex/compute-placement`
   — returns shared placement for all tenants. F02 will branch on
   `tenant.tier` and return dedicated placement for ENTERPRISE-tier
   tenants, with the corresponding `{workload}-tenant-{uuid}` Cloud
   Run service name (per ADR-COMPUTE-001).

This document specifies the swap-path contracts so F02 can land
without API surface changes for downstream callers (HTTP middleware,
deployment pipelines, etc.).

## Resolver 1 — `getQuotaConfig`

### Phase 1 contract (Slice C)

```typescript
function getQuotaConfig(tier: QuotaTier, resourceClass: ResourceClass): bigint;
```

Returns `DEFAULT_TIER_QUOTAS[tier][resourceClass]`. Pure function;
no DB query. Implementation in `packages/quotas/src/config.ts`.

### F02 contract

```typescript
function getQuotaConfig(
  tier: QuotaTier,
  resourceClass: ResourceClass,
  context?: { tenantId?: string; db?: NodePgDatabase },
): Promise<bigint>;
```

- If `context.tenantId` and `context.db` supplied: query
  `tenant_config_version` (latest version where
  `tenant_id = context.tenantId`); read
  `config_json.quotas[resourceClass]`; if present, return as bigint;
  otherwise fall back to `DEFAULT_TIER_QUOTAS[tier][resourceClass]`.
- If context is omitted: return
  `DEFAULT_TIER_QUOTAS[tier][resourceClass]` (Phase 1 behavior
  preserved for callers that don't have tenant context handy).

### Migration steps

1. F02 ships `tenant_config_version` row management (insert on
   tenant create, update on config change, query latest version on
   read).
2. F02 swaps `@cortex/quotas/src/config.ts` to the F02 contract
   above. Default-fallback path identical to Phase 1.
3. Convention doc updated to flag that callers wanting per-tenant
   overrides MUST supply `context`.
4. Existing callers (sub-phase 4's middleware) continue working
   without code changes — they don't supply `context` today, so they
   get the table fallback (same as Phase 1).
5. As F-services adopt per-tenant overrides, they pass `context` to
   the resolver.

### Test contract for the swap

The existing F02-swap regression guard test in `config.spec.ts`
(which asserts `getQuotaConfig(tier, class) === DEFAULT_TIER_QUOTAS[tier][class]`)
becomes the "no-context" branch test. F02 adds new tests for the
"with-context" branch (per-tenant override resolution + fallback).

## Resolver 2 — `getComputePlacement`

### Phase 1 contract (Slice C)

```typescript
function getComputePlacement(params: GetComputePlacementParams): Promise<ComputePlacement>;
```

Always returns `kind: 'shared'`. Validates params via Zod; throws
`ComputePlacementValidationError` on bad input. Implementation in
`packages/compute-placement/src/get-placement.ts`.

### F02 contract

```typescript
function getComputePlacement(
  params: GetComputePlacementParams,
  context: { db: NodePgDatabase },
): Promise<ComputePlacement>;
```

- Validates params (unchanged).
- Queries `tenant.tier` from the control plane:
  `SELECT tier FROM tenant WHERE id = $tenantId`.
- If `tier === 'ENTERPRISE'`: returns
  `kind: 'dedicated'`,
  `cloudRunService: '{workload}-tenant-{tenantId}'`,
  `placementLabel: 'dedicated'`,
  `tenantId: <id>`.
- If `tier === 'STANDARD'`: returns shared placement (same as Phase 1).
- If tenant row not found: throws `ComputePlacementConfigError` (NOT
  a validation error — caller passed a syntactically-valid UUID;
  semantic lookup failure).

### Migration steps

1. F02 ships `tenant.tier` writes (currently set on tenant create
   per Slice A; F02 adds tier-change automation when commercial-tier
   promotion happens).
2. F02 ships per-tenant Cloud Run service provisioning via Terraform
   module — when a tenant is promoted to ENTERPRISE, the module
   spins up `{workload}-tenant-{uuid}` services for each F-series
   workload that tenant uses.
3. F02 swaps `@cortex/compute-placement/src/get-placement.ts` to the
   F02 contract above. The `context` parameter becomes required.
4. Existing callers (none in Phase 1; this resolver has no
   downstream consumer yet) wire the `db` parameter when they ship.
5. ADR-COMPUTE-001 §5 ("F02 swap is purely additive") becomes
   Resolved.

### Test contract for the swap

Existing tests cover the `kind: 'shared'` branch + the
`parseCloudRunServiceName` round-trip. F02 adds tests for the
`kind: 'dedicated'` branch (`tenant.tier === 'ENTERPRISE'` lookup,
dedicated service-name construction, tenant-not-found error path).

## Cross-cutting design decisions

### Why `tenant_config_version` for quotas, not `tenant.tier` directly?

Quotas are tunable per-tenant (planning-doc Decision 7's "TUNABLE
baseline" framing). A specific tenant on STANDARD tier may need
higher `api_calls_per_minute` than the default — that override lives
in `tenant_config_version` where it can be versioned and audited,
not on the `tenant` row where it'd conflict with the commercial
tier label.

### Why `tenant.tier` for compute placement, not `tenant_config_version`?

Compute placement IS the commercial tier discriminator — it directly
maps STANDARD → shared, ENTERPRISE → dedicated. Putting it in
`tenant_config_version` would let a STANDARD-tier tenant be placed
dedicated, which is a billing/contractual discrepancy. The
`tenant.tier` column is the single source of truth for the
commercial tier; placement follows.

### Why Phase 1 stubs at all (vs blocking on F02)?

Three reasons:

1. Slice C's API surface lets F-series consumers (when they ship)
   compose against a stable contract today, not wait for F02.
2. The substrate (tenant_quota_usage RLS, audit chain integrity,
   framework-agnostic middleware) is real work that doesn't depend
   on F02; shipping it now avoids serializing the F01 → F02 →
   F-series critical path.
3. The Phase 1 → F02 transition is testable (regression guards in
   `config.spec.ts`) and contractual (this document); F02's risk is
   bounded.

## References

- **ADR-INFRA-007** — same substrate-now / real-impl-later pattern
  for KMS keys (Slice B precedent)
- **ADR-COMPUTE-001** — Cloud Run vs K8s + service-name format
- **`docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`**
  — Decision 7 (per-tier defaults), Decision 8 (BigInt), Decision 9
  (audit on 429)
- **`packages/quotas/src/config.ts`** — `getQuotaConfig` Phase 1
  implementation
- **`packages/compute-placement/src/get-placement.ts`** —
  `getComputePlacement` Phase 1 implementation
- **(future) F02 build prompt § Tenant Lifecycle** — F02's
  responsibility for `tenant_config_version` writes + per-tenant
  Cloud Run provisioning

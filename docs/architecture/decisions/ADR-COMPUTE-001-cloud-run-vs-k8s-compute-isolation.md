# ADR-COMPUTE-001: Cloud Run vs K8s for compute isolation

**Status:** Accepted
**Date:** 2026-04-26
**Deciders:** Amit (Sevyn8 engineering)
**Context documents:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.1 §3 (lines 962–965), Cortex v2.2 Spec §F01-FR-006, ADR-INFRA-006 (WIF), ADR-INFRA-003 (VPC topology), `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`
**Companion decisions:** ADR-INFRA-006 (WIF auth-target identity), ADR-INFRA-003 (VPC topology), ADR-INFRA-007 (Slice B precedent for substrate-now / real-impl-later pattern)

This is the first ADR in the `COMPUTE-*` series. Future compute placement
decisions (Cloud Run revision pinning, multi-region placement, edge
compute for ED01) extend this series.

---

## Context

F01 build prompt §3 specifies the compute-isolation model:

> Kubernetes namespace per Enterprise tenant
> Shared namespace with resource quotas for Standard tier
> Pod labeling for tenant_id propagation

Cortex's actual platform is **Cloud Run**, not Kubernetes:

- ADR-INFRA-006 establishes Workload Identity Federation with Cloud Run
  services as the auth-target identity layer. There is no GKE control
  plane.
- ADR-INFRA-003 establishes the VPC topology with a Serverless VPC
  Access Connector for Cloud Run; PSA networking for Cloud SQL
  reachability. K8s ingress / egress is not part of the architecture.
- The "platform engineering team of 1" reality (per Sevyn8 engineering
  context) does not support GKE control-plane ops.

Roadmap §9.7 has tracked this as an "anticipated deviation" since Slice
A (commit `4811821`). F01 Slice C is the first slice that has to
_resolve_ the deviation rather than defer it: `@cortex/compute-placement`
ships a `getComputePlacement(tenantId)` resolver, and the resolver's
return shape commits to a placement model.

Without this ADR, F02 inherits an ambiguous handoff: does it provision
GKE namespaces (matching the build prompt) or Cloud Run services
(matching the platform reality)? This decision answers that question
formally and locks the F02 swap path.

## Decision

Cortex compute isolation uses Cloud Run, not Kubernetes namespaces. The
tier discriminator routes between two placement models.

### 1. STANDARD tier — shared Cloud Run service per workload

All STANDARD-tier tenants share one Cloud Run service per logical
workload. Service name format:

```
{workload}-shared
```

Examples: `api-gateway-shared`, `dis-worker-shared`.

Env namespace is provided by the GCP project (`sevyn8-cortex-{env}`);
service uniqueness is per-project, so `api-gateway-shared` in
`sevyn8-cortex-dev` is a distinct service from `api-gateway-shared` in
`sevyn8-cortex-prod`. Operators correlating logs see env via the
project path:
`projects/sevyn8-cortex-prod/services/api-gateway-shared`.

Tenant binding flows via Slice A's `@cortex/tenant-context` async-local
context, set by HTTP middleware on every request. Resource quotas are
enforced per-request via `@cortex/quotas` (token bucket on
`tenant_quota_usage`). There is **no process-level isolation** between
STANDARD tenants in the shared service; isolation is application-layer
(RLS at the DB, AAD-bound encryption for PII, async-local for context,
quota enforcement for noisy-neighbor protection).

### 2. ENTERPRISE tier — dedicated Cloud Run service per tenant per workload

Each ENTERPRISE-tier tenant gets a dedicated Cloud Run service per
logical workload. Service name format:

```
{workload}-tenant-{tenantId}
```

Examples: `api-gateway-tenant-{uuid}`. Same env-via-project namespacing
as shared services. The 63-char Cloud Run service-name limit
constrains workload names to ≤19 chars (workload + `-tenant-` +
36-char UUID = 19 + 8 + 36 = 63 exactly at the limit). All
currently-planned Cortex workloads fit comfortably (longest:
`mcp-cortex-core` at 15 chars).

Properties:

- **Process-level isolation.** An ENTERPRISE tenant's bug, cold-start, or
  spike does not affect other tenants.
- **Per-tenant scaling, per-tenant cold-start budget.** Cloud Run's
  per-service min/max instances and concurrency apply per tenant.
- **Per-tenant operational quotas.** Cloud Run revision-level CPU,
  memory, concurrency are configurable per service — finer-grained than
  the application-layer token bucket. F02 + Terraform module configure
  these at provisioning time.
- **Per-tenant cost transparency.** Cloud Run billing is per service;
  ENTERPRISE-tier billing rolls up cleanly.

### 3. Slice C ships the resolver; F02 ships the provisioning

`@cortex/compute-placement.getComputePlacement(tenantId, db):
ComputePlacement` returns:

```typescript
type ComputePlacement =
  | { kind: 'shared'; cloudRunService: string }
  | { kind: 'dedicated'; cloudRunService: string };
```

**Phase 1 (Slice C):** Always returns `kind: 'shared'`,
`cloudRunService: '{workload}-shared'`. The `tenant.tier` column is
consulted but, since no ENTERPRISE tenant exists, the resolver
always returns shared placement.

**Phase 2+ (F02):** Resolver consults `tenant.tier`; for `'ENTERPRISE'`,
returns `kind: 'dedicated'` with the per-tenant service name. F02
lifecycle automation provisions / decommissions these services as
ENTERPRISE tenants are created / terminated.

### 4. Cloud Run labels (replaces K8s pod labeling)

F01 §3 says "pod labeling for tenant_id propagation". Cortex maps this
to **Cloud Run labels** on the service revision:

```
labels = {
  workload    = "<workload>"      # e.g., "api-gateway", "dis-worker"
  placement   = "shared|dedicated"  # deployment shape
  tenant_id   = "<uuid>"            # ENTERPRISE only; absent on shared service
  managed_by  = "terraform"
  prompt      = "<provisioning prompt>"
}
```

The `env` label is intentionally absent — env is encoded in the GCP
project path (`projects/sevyn8-cortex-{env}/...`); a Cloud Run label
would duplicate that signal. If a future use case wants env-in-labels
for cross-project Cloud Monitoring filtering, F02 can add it.

> Note: the Cloud Run `placement` label describes deployment shape, NOT
> commercial tier. `tenant.tier` (the column in the `tenant` table, with
> values `STANDARD` or `ENTERPRISE`) is the commercial-tier discriminator
> and lives in the database, not in Cloud Run labels. The
> compute-placement resolver bridges them — it consumes `tenant.tier`
> and returns a `ComputePlacement` with the corresponding Cloud Run
> service name + `placement` label value. Keeping the label key
> separate from `tenant.tier` prevents conflation when ops engineers
> debug from the Cloud Run console: `placement: shared` is unambiguous
> about deployment shape; `tier: shared` would conflict with the
> database's commercial-tier values.

For STANDARD shared services: `tenant_id` label is absent (the service is
not bound to one tenant). Per-request tenant binding lives in async-local
context, NOT in Cloud Run labels. Operators correlating logs to tenants
use the `tenant_id` field on log records (set by
`@cortex/observability`'s context provider), not Cloud Run service
labels.

For ENTERPRISE dedicated services: `tenant_id` label is set to the
tenant's UUID at provisioning time. Operators querying by Cloud Run
label can find the service for a tenant; correlating to logs uses the
same `tenant_id` log field.

**Service-name length budget.** The 63-char Cloud Run service-name
limit, the 36-char UUID for `tenantId`, and the fixed `-tenant-`
separator together bound workload names to ≤19 chars for dedicated
services (workload + `-tenant-` (8) + UUID (36) = 19 + 8 + 36 = 63
exactly at the limit). Shared services have no UUID component and
could accommodate longer workload names, but workload schemas enforce
the 19-char ceiling uniformly so that any workload can be promoted to
a dedicated deployment without renaming. Workload names that exceed
19 chars must be shortened (typically by abbreviation) before they
can deploy under ENTERPRISE tier; deployment pipelines validate this
via `parseCloudRunServiceName` from `@cortex/compute-placement`.

### 5. F02 swap is purely additive

When F02 ships ENTERPRISE provisioning:

1. F02 creates the per-tenant Cloud Run service via Terraform.
2. F02 updates `tenant.tier` to `'ENTERPRISE'` (or onboards the tenant
   directly at ENTERPRISE).
3. `getComputePlacement(tenantId)` starts returning `kind: 'dedicated'`
   for that tenant on next call. STANDARD tenants are unaffected.
4. No re-deploy, no API surface change, no `getComputePlacement`
   contract change. Same shape; different return value at runtime.

This mirrors ADR-INFRA-007's Slice B → F02 path for KMS keys: ship the
substrate now, return the Phase 1 stub value, F02 swaps the resolver
when the real value exists.

## Consequences

### Positive

- **No K8s control plane to operate.** Cloud Run is fully managed; no
  master upgrades, no node-pool sizing, no etcd backups. Matches the
  platform engineering team of 1 reality.
- **Per-tenant cost transparency at ENTERPRISE.** Cloud Run billing is
  per service; ENTERPRISE-tier billing rolls up cleanly without log
  parsing.
- **Cold-start isolation.** An ENTERPRISE tenant's cold-start does not
  impact STANDARD-tier latency. Each Cloud Run service has its own
  min/max instance budget.
- **Native CMEK + WIF + VPC integration already provisioned.**
  ADR-INFRA-004 (CMEK key hierarchy), ADR-INFRA-006 (WIF), ADR-INFRA-003
  (VPC) all apply natively to Cloud Run. No K8s-specific re-derivation
  of identity / encryption / networking.
- **F02 migration is purely additive.** New services, new resolver
  return values; no STANDARD-tier breakage. Same shape as Slice B's
  Phase 1 → Phase 2+ KMS migration.
- **Cloud Run labels match the F01 §3 "pod labeling" intent.**
  Operators querying by tenant_id (ENTERPRISE) or by workload+env
  (shared) get the same forensic discoverability as K8s would have
  provided.

### Negative

- **STANDARD tier has no process-level tenant isolation.** A bug in
  quota math, async-local context loss, or RLS bypass affects all
  STANDARD tenants in the shared service. Mitigation: defense in depth
  — Slice A's RLS + bind-on-every-tx pattern, Slice B's AAD-bound
  encryption (cross-tenant decrypt fails at the AEAD layer), Slice C's
  quota enforcement. Three independent isolation primitives; a single
  bug in any one doesn't compromise tenant data confidentiality.
- **Cross-tenant request smuggling becomes higher-stakes than under
  K8s namespace isolation.** Async-local context loss in a shared
  Cloud Run service could route tenant A's request to tenant B's
  context. Mitigation: `@cortex/tenant-context` binds tenant id at HTTP
  middleware entry; every DB transaction calls
  `bindTenantToDbSession(tx, tenantId)` before any tenant-scoped
  query; RLS denies any query where the bound tenant doesn't match the
  row tenant. Tests in `packages/tenant-context/test/middleware.spec.ts`
  exercise the binding lifecycle. Convention doc (sub-phase 8) flags
  this as the highest-priority correctness concern for any future
  middleware author.
- **Cloud Run service-per-tenant scales linearly with ENTERPRISE
  tenant count.** At >100 ENTERPRISE tenants per workload, deployment
  orchestration complexity grows: coordinated revision rollouts, per-
  tenant traffic-split policies, etc. Mitigation: F02 owns this; not a
  Slice C concern. If ENTERPRISE tenant count outgrows the
  service-per-tenant model, Phase 3+ may revisit (e.g., partition
  ENTERPRISE tenants into "tier-2" shared services with stronger
  quotas; the COMPUTE-\* ADR series captures the decision).
- **Cloud Run service-name length limit (63 chars) constrains
  workload names to ≤19 chars under dedicated placement.** The
  `{workload}-tenant-{uuid36}` format uses 19 + 8 + 36 = 63 exactly
  at the limit; workloads longer than 19 chars cannot deploy under
  ENTERPRISE tier without renaming. The naming format dropped both
  the `cortex-` prefix and the trailing `-{env}` suffix (vs the
  build prompt's natural reading) precisely to claw back the budget;
  env is encoded in the GCP project path. Mitigation: workload
  short-names (e.g., `api-gateway` not `cortex-api-gateway-service`);
  `cortexWorkloadSchema` enforces the 19-char ceiling at the schema
  layer; `parseCloudRunServiceName` catches name-length violations
  early during deployment validation.

### Neutral

- **Roadmap §9.7 (F01 compute isolation: K8s namespace vs Cloud Run
  anticipated deviation)** — RESOLVED by this ADR. Slice C sub-phase 9
  marks the entry Resolved.
- **Roadmap §10.3 (tenant tier discriminator)** — substrate-resolved by
  Slice A's `tenant.tier` column; this ADR is the first ADR-level
  consumer. Slice C sub-phase 9 marks the entry Resolved.
- **Roadmap §10.4 (DB client abstraction shape)** — F02 territory; this
  ADR confirms the ENTERPRISE path needs the shape (per-tenant DB
  client routing) but does NOT ship it. Roadmap §10.4 stays Open;
  F02 owns.

## References

- **ADR-INFRA-006** — Workload Identity Federation (Cloud Run is the
  auth-target identity)
- **ADR-INFRA-003** — VPC topology (Cloud Run runs inside the VPC
  connector)
- **ADR-INFRA-007** — Slice B precedent for substrate-now / real-impl-
  later resolver pattern
- **F01 build prompt** at `docs/build-prompts/cortex_build_prompts_v3.md`
  §P1.1 §3 (the K8s spec that this ADR diverges from)
- **Cortex v2.2 Spec §F01-FR-006** — compute isolation requirements
- **`docs/planning/f01-slice-c-quotas-compute-isolation-scope.md`** —
  Slice C scope doc (companion)
- **`packages/compute-placement/`** (sub-phase 6) — the consumer side
- **Roadmap §9.7** — F01 compute isolation: K8s namespace vs Cloud Run
  (resolved by this ADR)
- **Roadmap §10.3** — Tenant tier discriminator (resolved by Slice A
  substrate + Slice C first consumer)
- **Roadmap §10.4** — DB client abstraction shape (F02 territory;
  unchanged)

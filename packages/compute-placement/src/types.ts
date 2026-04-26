/**
 * Public types for `@cortex/compute-placement`.
 *
 * Per ADR-COMPUTE-001, Cortex compute uses Cloud Run (not K8s
 * namespaces). Tenant placement is one of two shapes:
 *
 *   - `'shared'` — STANDARD-tier tenant; one Cloud Run service per
 *     workload, all tenants share. Process-level isolation is
 *     application-layer (RLS + AAD encryption + async-local context
 *     binding + quota enforcement).
 *   - `'dedicated'` — ENTERPRISE-tier tenant; one Cloud Run service
 *     per tenant per workload. Process-level isolation; per-tenant
 *     scaling, cold-start budget, operational quotas.
 *
 * Service-name format (per ADR-COMPUTE-001 §1, §2, §4):
 *
 *   - shared:    `{workload}-shared` (e.g., `api-gateway-shared`)
 *   - dedicated: `{workload}-tenant-{tenantId}` (e.g., `api-gateway-tenant-{uuid}`)
 *
 * The `cortex-` prefix and `-{env}` suffix from earlier drafts are
 * intentionally absent — env is encoded in the GCP project path
 * (`projects/sevyn8-cortex-{env}/...`); the `cortex-` prefix is
 * implicit from the platform context. This trims 11+ characters from
 * the budget, leaving 19 chars for workload under dedicated naming
 * (workload + `-tenant-` + UUID = 63 chars at the limit).
 *
 * Phase 1 always returns `'shared'`. F02 swaps to consult
 * `tenant.tier`; the migration is purely additive (ADR-COMPUTE-001
 * Decision 5).
 */

/**
 * Compute placement decision for a tenant. Discriminated union on
 * `kind`; `placementLabel` is the value emitted on the corresponding
 * Cloud Run service's `placement` label (per ADR-COMPUTE-001 §4).
 */
export type ComputePlacement =
  | {
      readonly kind: 'shared';
      /** Format: `{workload}-shared`. */
      readonly cloudRunService: string;
      readonly placementLabel: 'shared';
    }
  | {
      readonly kind: 'dedicated';
      /** Format: `{workload}-tenant-{tenantId}`. */
      readonly cloudRunService: string;
      readonly placementLabel: 'dedicated';
      readonly tenantId: string;
    };

/**
 * Cortex environment discriminator. Surfaced in
 * `GetComputePlacementParams` for caller-side observability /
 * logging context. NOT used in Cloud Run service-name construction
 * — env is encoded in the GCP project path; embedding it in the
 * service name would duplicate the signal and consume budget needed
 * for the tenant UUID under dedicated placement.
 */
export type CortexEnv = 'dev' | 'staging' | 'prod';

/**
 * Cortex workload identifier. Short canonical name used in Cloud Run
 * service naming. F-series consumers pass their own workload string
 * (e.g., `'api-gateway'`, `'dis-worker'`, `'mcp-cortex-core'`).
 *
 * Length-constrained per `cortexWorkloadSchema` to ≤19 chars. The
 * 63-char Cloud Run service-name limit + the 36-char UUID + the
 * 8-char `-tenant-` separator together leave exactly 19 chars for
 * workload under dedicated placement (`{workload}-tenant-{uuid36}` =
 * 19 + 8 + 36 = 63 at the limit). All currently-planned Cortex
 * workloads fit (longest: `mcp-cortex-core` at 15 chars).
 *
 * The schema enforces the 19-char ceiling uniformly across both
 * placement shapes — even though shared services have no UUID
 * component and could fit longer names — so any workload can be
 * promoted to dedicated deployment without renaming.
 */
export type CortexWorkload = string;

/**
 * Resolver input. Phase 1 ignores `tenantId`; F02 will use it to
 * query `tenant.tier` from the control plane. `env` is validated but
 * does NOT appear in the returned `cloudRunService` string — see
 * `CortexEnv` JSDoc.
 */
export interface GetComputePlacementParams {
  readonly tenantId: string;
  readonly workload: CortexWorkload;
  readonly env: CortexEnv;
}

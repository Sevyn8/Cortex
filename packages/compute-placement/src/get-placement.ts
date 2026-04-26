/**
 * Phase 1 compute-placement resolver for `@cortex/compute-placement`.
 *
 * Two surfaces:
 *
 *   - `getComputePlacement(params)` — returns the placement for a
 *     `(tenantId, workload, env)` triple. Phase 1: always `'shared'`.
 *     F02 will branch on `tenant.tier` and return `'dedicated'` for
 *     ENTERPRISE-tier tenants (purely additive per ADR-COMPUTE-001
 *     Decision 5).
 *
 *   - `parseCloudRunServiceName(name)` — inverse for forensics;
 *     extracts `(workload, tenantId|null)` from a service name.
 *     Used by deployment pipelines validating service names against
 *     the 63-char Cloud Run limit + Cortex naming conventions.
 *
 * Service-name format (per ADR-COMPUTE-001 §1, §2, §4):
 *   - shared:    `{workload}-shared`
 *   - dedicated: `{workload}-tenant-{tenantId}`
 *
 * `env` is NOT in the service name — it's encoded in the GCP project
 * path (`projects/sevyn8-cortex-{env}/...`). The resolver accepts
 * `env` for caller-side observability context but doesn't embed it.
 *
 * The resolver is `async` for forward compatibility — F02 will need
 * to query `tenant.tier` from the DB, so the signature already
 * accommodates the async path. Phase 1 implementation is synchronous
 * but wrapped in `Promise.resolve` semantics via `async`.
 */

import { ComputePlacementValidationError } from './errors.js';
import { getComputePlacementParamsSchema } from './schemas.js';
import type { ComputePlacement, CortexWorkload, GetComputePlacementParams } from './types.js';

/**
 * Resolve compute placement for a tenant + workload + env.
 *
 * Phase 1: always returns `'shared'` placement with
 * `cloudRunService: '{workload}-shared'`. No real ENTERPRISE tenants
 * exist yet; this stub lets callers code against the API surface
 * today without waiting for F02's per-tenant Cloud Run provisioning.
 *
 * F02: will consult `tenant.tier` (via `@cortex/canonical-schema`'s
 * `tenant` table). For `tier='ENTERPRISE'`, returns `'dedicated'`
 * with `{workload}-tenant-{tenantId}` as the service name. For
 * `tier='STANDARD'`, returns `'shared'` as today.
 *
 * @throws ComputePlacementValidationError on malformed params
 */
export function getComputePlacement(params: GetComputePlacementParams): Promise<ComputePlacement> {
  // Phase 1 implementation is synchronous; the Promise return type is
  // forward-compat for F02 (which will query tenant.tier from the DB).
  // The function deliberately is NOT `async` to avoid the
  // @typescript-eslint/require-await rule on a body with no await —
  // `Promise.resolve(...)` gives the same caller-side Promise return.
  const parsed = getComputePlacementParamsSchema.safeParse(params);
  if (!parsed.success) {
    return Promise.reject(
      new ComputePlacementValidationError(
        `Invalid getComputePlacement params: ${parsed.error.message}`,
        { cause: parsed.error },
      ),
    );
  }

  const { workload } = parsed.data;
  // env is validated above but NOT used in the service name — see
  // file header. Retained in params for forward-compat (F02 may use
  // it for placement-decision logging) and to keep the API
  // signature stable across the F02 swap.

  // Phase 1: always shared. F02 will branch on tenant.tier here.
  return Promise.resolve({
    kind: 'shared',
    cloudRunService: `${workload}-shared`,
    placementLabel: 'shared',
  });
}

/**
 * Validates a Cloud Run service name against the conventions
 * established in ADR-COMPUTE-001 §4. Useful for deployment pipelines
 * that need to verify a service name fits the 63-char Cloud Run
 * limit before provisioning, or to round-trip a service name back to
 * its `(workload, tenantId?)` components for forensics.
 *
 * Two formats accepted:
 *
 *   - SHARED: `{workload}-shared` → `tenantId: null`
 *   - DEDICATED: `{workload}-tenant-{uuid}` → `tenantId: uuid`
 *
 * Workload pattern: must start with a letter, then lowercase
 * alphanumeric + hyphens. The dedicated regex matches eagerly until
 * `-tenant-{uuid}` (UUID is the 36-char canonical form). Tries
 * dedicated FIRST so a workload-name ending in `-shared` followed by
 * a tenant suffix isn't misparsed as shared.
 *
 * @throws ComputePlacementValidationError on >63 chars or no pattern match
 */
export function parseCloudRunServiceName(serviceName: string): {
  workload: CortexWorkload;
  tenantId: string | null;
} {
  if (serviceName.length > 63) {
    throw new ComputePlacementValidationError(
      `Cloud Run service name exceeds 63-char limit: ${serviceName.length} chars (${serviceName})`,
    );
  }

  // Pattern A (dedicated): {workload}-tenant-{uuid36}
  // The non-greedy `+?` for workload ensures the LAST `-tenant-`
  // boundary is matched (workload itself may contain hyphens).
  const dedicatedPattern =
    /^([a-z][a-z0-9-]*?)-tenant-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  const dedicatedMatch = dedicatedPattern.exec(serviceName);
  if (dedicatedMatch) {
    return {
      workload: dedicatedMatch[1]!,
      tenantId: dedicatedMatch[2]!,
    };
  }

  // Pattern B (shared): {workload}-shared
  const sharedPattern = /^([a-z][a-z0-9-]*)-shared$/;
  const sharedMatch = sharedPattern.exec(serviceName);
  if (sharedMatch) {
    return {
      workload: sharedMatch[1]!,
      tenantId: null,
    };
  }

  throw new ComputePlacementValidationError(
    `Service name does not match Cortex naming conventions: ${serviceName}`,
  );
}

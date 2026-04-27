/**
 * Compute-placement resolver for `@cortex/compute-placement`.
 *
 * Two surfaces:
 *
 *   - `getComputePlacement(params, db)` — returns the placement for a
 *     `(tenantId, workload, env)` triple. F02 Slice A swap (sub-phase
 *     5.4): branches on `tenant.tier`. ENTERPRISE tenants → dedicated
 *     Cloud Run service (`{workload}-tenant-{tenantId}`); STANDARD →
 *     shared (`{workload}-shared`). Phase 1 stub returned shared
 *     unconditionally; F02 actually consults the tier.
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
 * RLS: the `tenant` table has NO RLS policy (control plane). The
 * SELECT for `tenant.tier` works without `bindTenantToDbSession`.
 *
 * `db` is passed as a separate argument (not embedded in `params`)
 * because Drizzle DB instances aren't trivially zod-validatable; the
 * params zod schema validates `tenantId`, `workload`, `env` cleanly
 * without dealing with the `db` object's shape.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenant } from '@cortex/canonical-schema';
import { ComputePlacementConfigError, ComputePlacementValidationError } from './errors.js';
import { getComputePlacementParamsSchema } from './schemas.js';
import type { ComputePlacement, CortexWorkload, GetComputePlacementParams } from './types.js';

/**
 * Resolve compute placement for a tenant + workload + env.
 *
 * Queries `tenant.tier` to branch the placement decision. ENTERPRISE
 * tenants get dedicated services per ADR-COMPUTE-001; STANDARD tenants
 * share. The `env` field is validated but NOT embedded in the service
 * name (encoded in the GCP project path).
 *
 * @throws ComputePlacementValidationError on malformed `params` (zod).
 * @throws ComputePlacementConfigError when no `tenant` row matches the
 *   supplied `tenantId` — tenant must be provisioned before placement
 *   resolution; F02 Slice A's `tenants.provision` populates the row.
 */
export async function getComputePlacement(
  params: GetComputePlacementParams,
  db: NodePgDatabase<Record<string, never>>,
): Promise<ComputePlacement> {
  const parsed = getComputePlacementParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new ComputePlacementValidationError(
      `Invalid getComputePlacement params: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  const { tenantId, workload } = parsed.data;
  // env is validated above but NOT used in the service name — see file
  // header. Retained in params for caller-side observability context
  // and to keep the API signature stable.

  const rows = await db
    .select({ tier: tenant.tier })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    throw new ComputePlacementConfigError(
      `Tenant ${tenantId} not found in compute-placement resolver — provision via tenants.provision before requesting placement.`,
    );
  }

  if (row.tier === 'ENTERPRISE') {
    return {
      kind: 'dedicated',
      cloudRunService: `${workload}-tenant-${tenantId}`,
      placementLabel: 'dedicated',
      tenantId,
    };
  }

  // STANDARD: shared placement.
  return {
    kind: 'shared',
    cloudRunService: `${workload}-shared`,
    placementLabel: 'shared',
  };
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

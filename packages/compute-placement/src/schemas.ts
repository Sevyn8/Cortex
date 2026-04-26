/**
 * Zod schemas for `@cortex/compute-placement`.
 *
 * Validates `getComputePlacement` params and the constituent string
 * fields. Workload names follow Cloud Run's service-name character
 * rules (lowercase alphanumeric + hyphens, must start with a letter)
 * and are bounded by the 63-char Cloud Run service-name limit under
 * dedicated placement.
 */

import { z } from 'zod';

export const cortexEnvSchema = z.enum(['dev', 'staging', 'prod']);

export const tenantIdSchema = z.string().uuid();

/**
 * Workload identifier. Lowercase alphanumeric + hyphens, must start
 * with a letter, length 1..19.
 *
 * Per ADR-COMPUTE-001 §4 service-name length budget:
 *   workload + '-tenant-' (8) + uuid (36) = 63 exactly at Cloud Run limit
 *
 * The 19-char ceiling is enforced uniformly across both placement
 * shapes (shared and dedicated) so any workload can be promoted to
 * dedicated deployment without renaming.
 */
export const cortexWorkloadSchema = z
  .string()
  .min(1)
  .max(19, 'workload must be ≤19 chars (per ADR-COMPUTE-001 §4 service-name length budget)')
  .regex(
    /^[a-z][a-z0-9-]*$/,
    'workload must start with a letter and contain only lowercase alphanumerics + hyphens',
  );

export const getComputePlacementParamsSchema = z.object({
  tenantId: tenantIdSchema,
  workload: cortexWorkloadSchema,
  env: cortexEnvSchema,
});

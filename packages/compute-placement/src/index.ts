/**
 * Public barrel for `@cortex/compute-placement`.
 *
 * Phase 1 stub returning `'shared'` placement for all tenants.
 * F02 will swap the resolver to consult `tenant.tier`; the migration
 * is purely additive (ADR-COMPUTE-001 Decision 5).
 */

// Errors + envelope
export {
  ComputePlacementError,
  ComputePlacementConfigError,
  ComputePlacementValidationError,
  toComputePlacementErrorEnvelope,
  type ComputePlacementErrorCode,
  type ComputePlacementErrorEnvelope,
} from './errors.js';

// Types
export {
  type ComputePlacement,
  type CortexEnv,
  type CortexWorkload,
  type GetComputePlacementParams,
} from './types.js';

// Schemas — exposed for callers wanting direct parse access
export {
  cortexEnvSchema,
  cortexWorkloadSchema,
  getComputePlacementParamsSchema,
  tenantIdSchema,
} from './schemas.js';

// Resolver + service-name parser
export { getComputePlacement, parseCloudRunServiceName } from './get-placement.js';

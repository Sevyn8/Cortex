/**
 * `@cortex/insurance-cac-pack`: the insurance-cac Atlas pack skeleton.
 *
 * Pack CONTENT (Tier 2), not engine code: the concrete 8-stage insurance funnel,
 * its cold-start benchmarks, the 65-line cost ontology, and a V3-PACK-FR-001
 * manifest. Conforms to the neutral shapes from @cortex/cac-types and feeds the
 * @cortex/funnel-economics primitive. This is a validated pack artifact, not a
 * loadable signed pack: no Atlas registry or DIS loader exists yet (V3-PACK-FR-005).
 */
export {
  INSURANCE_FUNNEL,
  COMPOSITE_BENCHMARKS,
  COLD_START_COUNTS,
  flaggableStageKeys,
} from './funnel.js';
export { INSURANCE_COST_ONTOLOGY } from './cost-ontology.js';
export type { CostLineAssignment } from './cost-ontology.js';
export {
  PACK_MANIFEST,
  packManifestSchema,
  validateManifest,
  DEFERRED_PACK_FIELDS,
} from './manifest.js';
export type { PackManifest } from './manifest.js';

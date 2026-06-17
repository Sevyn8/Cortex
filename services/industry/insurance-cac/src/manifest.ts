/**
 * The insurance-cac pack manifest.
 *
 * Carries the V3-PACK-FR-001 manifest fields that apply at skeleton stage: id,
 * version (SemVer, V3-PACK-FR-002), engine-compat range, and a signature
 * placeholder (real cosign signing and loader verification land with registry
 * v0, V3-PACK-FR-003 and FR-005). The remaining V3-PACK-FR-001 contents are
 * deferred to later phases; see `DEFERRED_PACK_FIELDS`.
 */
import { z } from 'zod';

/** Required manifest fields at skeleton stage (V3-PACK-FR-001 manifest tuple). */
export const packManifestSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be SemVer (V3-PACK-FR-002)'),
    engine_compat: z.string().min(1),
    signature: z
      .object({
        signed: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export type PackManifest = z.infer<typeof packManifestSchema>;

export const PACK_MANIFEST = {
  id: 'insurance-cac',
  version: '0.1.0',
  /** SemVer range of compatible engines. Provisional until the engine-compat contract is fixed. */
  engine_compat: '>=0.1.0 <0.2.0',
  signature: {
    signed: false,
    algorithm: null,
    value: null,
    note: 'placeholder; cosign signing and loader verification land with registry v0 (V3-PACK-FR-003, V3-PACK-FR-005)',
  },
  /** Content authored at skeleton stage. */
  contents: {
    funnel: '8-stage insurance funnel (insurance-cac-funnel-stages.md)',
    coldStartBenchmarks:
      'composite benchmarks plus per-stage benchmark CVRs (nullable placeholders)',
    costOntology: '65-line cost-line-to-stage assignment (insurance-cac-cost-stage-map.md)',
  },
} as const;

/**
 * V3-PACK-FR-001 fields deliberately deferred past the skeleton, with why. These
 * land in later phases (plan.md) and are not invented here.
 */
export const DEFERRED_PACK_FIELDS: readonly { field: string; reason: string }[] = [
  {
    field: 'canonical schema (Tier 2, PII per field)',
    reason: 'Phase 2 insurance schema via the workbench (V3-INS-FR-001)',
  },
  { field: 'validation and quarantine rules', reason: 'Phase 2 junk suppression (V3-INS-FR-004)' },
  {
    field: 'KPI and metric definitions',
    reason:
      'CAC KPI shape exists in @cortex/cac-types; full pack KPI defs are Phase 2 (V3-INS-FR-003)',
  },
  { field: 'dashboard templates', reason: 'Phase 2 baseline CAC dashboards (section 8.1)' },
  { field: 'UI manifest and terminology bundle (IC02)', reason: 'Phase 2 experience surface' },
  { field: 'media extraction rules', reason: 'Phase 4 media pipeline (V3-INS-FR-006, V3-MED)' },
  {
    field: 'scoring rules (A06 format)',
    reason: 'Phase 3 intelligence plane (V3-INS-FR-005, V3-A06)',
  },
  { field: 'agent playbooks', reason: 'Phase 6 agents (V3-AGNT)' },
  { field: 'reference and demo data', reason: 'Phase 2 pack-seeded demo tenant' },
  {
    field: 'embeddings snapshot for mapping auto-suggest',
    reason: 'Phase 2 workbench corpus (V3-D02, V3-PACK-FR-010)',
  },
];

/** Validate the manifest against the required V3-PACK-FR-001 skeleton fields. */
export function validateManifest(manifest: unknown = PACK_MANIFEST): PackManifest {
  return packManifestSchema.parse(manifest);
}

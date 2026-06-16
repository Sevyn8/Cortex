/**
 * The insurance-cac pack funnel: the concrete 8-stage insurance funnel instance.
 *
 * This is pack CONTENT (Tier 2). The concrete stage list deliberately lives here
 * and NOT in @cortex/cac-types (it was removed from shared types in ADR-CAC-002,
 * invariant 2). Each stage conforms to the neutral `FunnelStage` shape imported
 * from @cortex/cac-types; we satisfy that type, we do not re-declare it.
 *
 * Source: docs/spec/v3/cac/insurance-cac-funnel-stages.md (the ratified 8-stage
 * model and its illustrative vertical_config). Per-stage allocation basis is NOT
 * a FunnelStage field; it is a per-cost-line attribute and lives in the cost
 * ontology (see cost-ontology.ts), which is where the funnel-economics primitive
 * expects it.
 */
import type { FunnelStage } from '@cortex/cac-types';
import type { StageCount } from '@cortex/funnel-economics';

/**
 * The 8 stages. `benchmark_step_cvr` is the cold-start step CVR from the prior
 * stage; `null` means measured but not flagged (the placeholder design: the
 * inserted middle stages contact and quote ship null so LEAK cannot fire on
 * invented numbers). `cost_line_group` references the cost-ontology group for
 * the stage, which is the set of cost lines whose `stage` equals this key.
 */
export const INSURANCE_FUNNEL: FunnelStage[] = [
  {
    n: 1,
    key: 'impression',
    canonical_event: 'impression',
    benchmark_step_cvr: null,
    cost_line_group: 'impression',
  },
  {
    n: 2,
    key: 'click',
    canonical_event: 'click',
    benchmark_step_cvr: 0.015,
    cost_line_group: 'click',
  },
  {
    n: 3,
    key: 'lead',
    canonical_event: 'lead_created',
    benchmark_step_cvr: 0.08,
    cost_line_group: 'lead',
  },
  {
    n: 4,
    key: 'contact',
    canonical_event: 'lead_contacted',
    benchmark_step_cvr: null,
    cost_line_group: 'contact',
  },
  {
    n: 5,
    key: 'qualified',
    canonical_event: 'lead_qualified',
    benchmark_step_cvr: null,
    cost_line_group: 'qualified',
  },
  {
    n: 6,
    key: 'quote',
    canonical_event: 'quote_issued',
    benchmark_step_cvr: null,
    cost_line_group: 'quote',
  },
  {
    n: 7,
    key: 'policy',
    canonical_event: 'policy_issued',
    benchmark_step_cvr: null,
    cost_line_group: 'policy',
  },
  {
    n: 8,
    key: 'retained_13m',
    canonical_event: 'policy_retained_13m',
    benchmark_step_cvr: 0.9,
    cost_line_group: 'retained_13m',
    derived: true,
  },
];

/**
 * Sourced composite benchmarks (funnel-stages.md section 2). These are "what
 * good looks like" and are used while the inserted per-stage splits remain
 * placeholders (null). Persistency 0.90 is also the retained_13m stage benchmark.
 */
export const COMPOSITE_BENCHMARKS = {
  lead_to_qualified: 0.55,
  qualified_to_policy: 0.3,
  persistency_13m: 0.9,
} as const;

/**
 * Cold-start "what good looks like" counts: a funnel whose composite CVRs equal
 * the sourced composites exactly (qualified/lead 0.55, policy/qualified 0.30,
 * retained/policy 0.90). Top funnel uses the benchmark CTR 0.015 and landing CVR
 * 0.08 (impression 20,000,000 to click 300,000 to lead 24,000). The contact and
 * quote counts are intermediate placeholders chosen monotonic; they do not
 * affect the three sourced composites.
 */
export const COLD_START_COUNTS: StageCount[] = [
  { stage: 'impression', count: 20_000_000 },
  { stage: 'click', count: 300_000 },
  { stage: 'lead', count: 24_000 },
  { stage: 'contact', count: 16_800 },
  { stage: 'qualified', count: 13_200 },
  { stage: 'quote', count: 8_580 },
  { stage: 'policy', count: 3_960 },
  { stage: 'retained_13m', count: 3_564 },
];

/**
 * The stages a LEAK rule could fire on: those with a non-null benchmark step
 * CVR. Stages with a null benchmark (the placeholders) are deliberately absent,
 * so no placeholder number can produce a LEAK signal. The LEAK rule itself is an
 * intelligence-plane judgment (ADR-CAC-002) and is not implemented here; this is
 * only the set of stages that carry a benchmark to compare against.
 */
export function flaggableStageKeys(funnel: FunnelStage[] = INSURANCE_FUNNEL): string[] {
  return funnel.filter((s) => s.benchmark_step_cvr !== null).map((s) => s.key);
}

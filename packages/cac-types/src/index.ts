/**
 * `@cortex/cac-types`: vertical-neutral domain shapes for the CAC app.
 *
 * Per ADR-CAC-001 the insurance CAC product is an app (the Atlas V3-INS pack
 * plus generic platform capabilities), not a service. Per architecture-spec
 * invariant 2 (new vertical equals new pack, zero engine commits) and
 * ADR-CAC-002, this package holds only vertical-NEUTRAL shapes: what a funnel
 * stage is, how a fact may be grouped, and the CAC KPI input shape. The
 * concrete insurance stage LIST (the ratified 8-stage model) is pack content
 * (Tier 2), authored in the insurance pack, never here. The `./generated` seam
 * carries interim local stand-ins for the contracts-repo C2 facts.
 *
 * Build package: emits `dist/` so other workspaces load compiled JS.
 */
import { z } from 'zod';

export * from './generated/index.js';

/**
 * Stage key: a pack-defined identifier for one funnel stage (for example
 * `impression` or `policy_retained_13m`). Vertical-neutral: the set of valid
 * keys is pack content (Tier 2), never enumerated in shared types (invariant 2).
 */
export const stageKeySchema = z.string().min(1);
export type StageKey = z.infer<typeof stageKeySchema>;

/**
 * Funnel stage SHAPE (not a list). The schema for what a stage is; the ordered
 * set of concrete stages is authored in the insurance pack from
 * docs/spec/v3/cac/insurance-cac-funnel-stages.md (the ratified 8-stage model:
 * impression, click, lead, contact, qualified, quote, policy, retained at 13
 * months). A pack supplies an array of these; the funnel-economics primitive (a
 * later, separate compute package) consumes them.
 */
export const funnelStageSchema = z.object({
  /** Ordinal position in the funnel, 1-based. */
  n: z.number().int().positive(),
  /** Pack-defined stage key. */
  key: stageKeySchema,
  /** Canonical event the stage keys off (for example `lead_created`). */
  canonical_event: z.string().min(1),
  /**
   * Cold-start benchmark step CVR from the prior stage, in [0, 1]. `null` means
   * measured but not flagged (no benchmark set, so the LEAK rule does not fire).
   */
  benchmark_step_cvr: z.number().min(0).max(1).nullable(),
  /** Reference to the cost-line group allocated to this stage (cost ontology). */
  cost_line_group: z.string().min(1).optional(),
  /** Derived stage (for example a 13-month retention evaluation), not a raw event. */
  derived: z.boolean().optional(),
});
export type FunnelStage = z.infer<typeof funnelStageSchema>;

/**
 * Grouping axes a fact may be grouped by: a channel key and a cohort key. Stable
 * Tier-1 structure. The set of channel VALUES and the semantics of cohorts are
 * pack (Tier 2) and tenant (Tier 3) content authored in Phase 2, never
 * enumerated here. `null` means ungrouped on that axis.
 */
export const channelKeySchema = z.string().min(1);
export type ChannelKey = z.infer<typeof channelKeySchema>;
export const cohortKeySchema = z.string().min(1);
export type CohortKey = z.infer<typeof cohortKeySchema>;
export const groupingDimensionsSchema = z.object({
  channel: channelKeySchema.nullable(),
  cohort: cohortKeySchema.nullable(),
});
export type GroupingDimensions = z.infer<typeof groupingDimensionsSchema>;

/**
 * A funnel stage transition. Shape only: the canonical spine event envelope
 * (contract C2) is owned by the contracts repo and surfaces via `./generated`.
 * From and to reference pack-defined stage keys, not a shared enum.
 */
export const funnelTransitionSchema = z.object({
  entity_ref: z.string().min(1),
  from_stage: stageKeySchema.nullable(),
  to_stage: stageKeySchema,
  occurred_at: z.string().datetime(),
});
export type FunnelTransition = z.infer<typeof funnelTransitionSchema>;

/**
 * CAC KPI definition (V3-INS-FR-003): attributable acquisition spend divided by
 * issued policies, sliced by channel, campaign, product, and period. The
 * computation lives in a pure compute package (built later, per V3-FUNNEL
 * section 2); this is the input shape only.
 */
export const cacKpiSchema = z.object({
  period: z.string().min(1),
  channel: z.string().optional(),
  campaign: z.string().optional(),
  product: z.string().optional(),
  attributable_spend: z.number().nonnegative(),
  issued_policies: z.number().int().nonnegative(),
});
export type CacKpi = z.infer<typeof cacKpiSchema>;

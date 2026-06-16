/**
 * Interim local stand-ins for contracts-repo facts (ADR-CAC-002, item 5).
 *
 * The `sevyn8/contracts` repo does not exist yet (stood up in Phase R per
 * docs/spec/v3/plan.md). Until codegen lands, the CAC facts the primitive needs
 * are hand-authored here as plain typed Zod shapes, deliberately swappable for
 * the real C2 spine-event contracts later. When codegen lands, these are
 * replaced by generated modules and this file returns to a re-export barrel.
 * See `./README.md`.
 */
import { z } from 'zod';

/**
 * `funnel_event`: a stage-transition fact (interim; the real shape is the C2
 * spine event envelope). Carries the grouping axes (channel, cohort) a fact may
 * be grouped by; their values are pack and tenant content, never enumerated
 * here (no `dim_channel_cohort` enumeration exists).
 */
export const funnelEventSchema = z.object({
  event_id: z.string().min(1),
  tenant_id: z.string().min(1),
  entity_ref: z.string().min(1),
  stage_key: z.string().min(1),
  from_stage: z.string().min(1).nullable(),
  to_stage: z.string().min(1),
  occurred_at: z.string().datetime(),
  channel: z.string().min(1).nullable(),
  cohort: z.string().min(1).nullable(),
  source: z.string().min(1).optional(),
});
export type FunnelEvent = z.infer<typeof funnelEventSchema>;

/**
 * `cost_line`: an allocated acquisition cost line (interim). `funnel_stage` is
 * the pack-assigned stage key (see
 * docs/spec/v3/cac/insurance-cac-cost-stage-map.md). `amount` may be negative
 * (for example commission clawback recovery). The allocation-basis vocabulary
 * is platform-generic (V3-FUNNEL-FR-003) and kept as a string here, not an
 * enum, to stay swappable.
 */
export const costLineSchema = z.object({
  cost_line_id: z.string().min(1),
  tenant_id: z.string().min(1),
  funnel_stage: z.string().min(1),
  allocation_basis: z.string().min(1),
  amount: z.number(),
  currency: z.string().min(1).optional(),
  leakage_flag: z.boolean().optional(),
  channel: z.string().min(1).nullable(),
  cohort: z.string().min(1).nullable(),
  period: z.string().min(1),
});
export type CostLine = z.infer<typeof costLineSchema>;

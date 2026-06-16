/**
 * `@cortex/cac-types` — domain types for the insurance CAC app.
 *
 * Per ADR-CAC-001, the insurance CAC product is an app (the Atlas V3-INS pack
 * plus generic platform capabilities), not a service. This package therefore
 * holds the CAC funnel, measurement, and insurance-pack domain types, plus the
 * `./generated` seam for types generated from the contracts repo. There is no
 * cac-engine.
 *
 * Build package: emits `dist/` so other workspaces load compiled JS.
 */
import { z } from 'zod';

export * from './generated/index.js';

/**
 * Insurance acquisition funnel stages (V3-INS-FR-002; see
 * docs/spec/v3/cac/V3-FUNNEL.md). Seven ratified stages. An eighth stage is an
 * OPEN operator decision (V3-FUNNEL section 4) and is intentionally NOT encoded
 * here until reconciled; benchmark step CVRs are likewise operator-supplied and
 * are not defined in this package.
 */
export const FUNNEL_STAGES = [
  'lead_received',
  'contacted',
  'qualified',
  'quoted',
  'proposal_submitted',
  'payment',
  'issued',
] as const;

export const funnelStageSchema = z.enum(FUNNEL_STAGES);
export type FunnelStage = z.infer<typeof funnelStageSchema>;

/**
 * A funnel stage transition. Shape only: the canonical spine event envelope
 * (contract C2) is owned by the contracts repo and surfaces via `./generated`.
 */
export const funnelTransitionSchema = z.object({
  entity_ref: z.string().min(1),
  from_stage: funnelStageSchema.nullable(),
  to_stage: funnelStageSchema,
  occurred_at: z.string().datetime(),
});
export type FunnelTransition = z.infer<typeof funnelTransitionSchema>;

/**
 * CAC KPI definition (V3-INS-FR-003): attributable acquisition spend divided by
 * issued policies, sliced by channel, campaign, product, and period. The
 * computation lives in the semantic layer; this is the input shape.
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

/**
 * Input and output shapes for the funnel-economics primitive.
 *
 * Vertical-neutral by construction: stages are supplied as the neutral stage
 * shape from `@cortex/cac-types` (so the fact-schema source is swappable), and
 * the issued and retained denominators are named by stage key rather than
 * hardcoded, so no stage names or stage count are baked in here.
 */
import type { FunnelStage, StageKey, GroupingDimensions } from '@cortex/cac-types';

export type { FunnelStage, StageKey, GroupingDimensions };

/** How a cost line maps onto stages. */
export type AllocationMode = 'direct' | 'allocated' | 'fixed';

/** The spreading basis for non-direct (allocated or fixed) cost lines. */
export type AllocationBasis = 'volume' | 'leads' | 'customers' | 'equal' | 'revenue';

/** A per-stage observed count, optionally tagged on the grouping axes. */
export interface StageCount extends Partial<GroupingDimensions> {
  stage: StageKey;
  count: number;
}

/** A cost line assigned to a stage with an allocation rule, optionally tagged on the grouping axes. */
export interface CostLineInput extends Partial<GroupingDimensions> {
  id?: string;
  stage: StageKey;
  amount: number;
  mode: AllocationMode;
  /** Required when `mode` is `allocated` or `fixed`. */
  basis?: AllocationBasis;
  leakageFlag?: boolean;
}

/**
 * Recovery model for loss-adjusted CAC. `recovered = units * product(factors)`.
 * When `units` is omitted it defaults to `issued - retained` for the series, so
 * the model stays correct per group without restating per-group counts. The
 * factors are a multiplicative rate chain (for example a unit value followed by
 * one or more rates); they are group-invariant.
 */
export interface RecoveryModel {
  units?: number;
  factors: number[];
}

/** Which stage's count is the issued denominator and which is the retained denominator. */
export interface Denominators {
  issuedStage: StageKey;
  retainedStage: StageKey;
}

export interface FunnelEconomicsInput {
  stages: FunnelStage[];
  counts: StageCount[];
  costLines: CostLineInput[];
  denominators: Denominators;
  recovery?: RecoveryModel;
  /** Per-stage revenue weights keyed by stage key; required only if a cost line uses basis `revenue`. */
  revenueWeights?: Record<string, number>;
  /** Group results by this axis (`channel` or `cohort`); when omitted, results are blended only. */
  groupBy?: keyof GroupingDimensions;
}

export interface StageMetric {
  stage: StageKey;
  n: number;
  count: number;
  /** Allocated cost landing on this stage. */
  cost: number;
  /** count / previous count; null at the entry stage. */
  stepCvr: number | null;
  /** previous count - count; 0 at the entry stage. */
  dropOff: number;
  /** count / entry count. */
  cumulativeSurvival: number;
  /** cumulative cost through this stage / count at this stage. */
  runningCostPerSurvivor: number;
  /**
   * Spend lost to the entities that dropped off reaching this stage: the
   * per-survivor running cost at the previous stage times this stage's dropOff.
   * 0 at the entry stage.
   */
  wastedSpend: number;
}

export interface SeriesResult {
  stages: StageMetric[];
  totalAcquisitionCost: number;
  issued: number;
  retained: number;
  recoveredAmount: number;
  /** totalAcquisitionCost / issued. */
  grossCac: number;
  /** (totalAcquisitionCost - recoveredAmount) / retained. */
  lossAdjustedCac: number;
}

export interface FunnelEconomicsResult {
  /** The grouping axis used, or null when blended only. */
  groupBy: keyof GroupingDimensions | null;
  /** Series computed over all data, regardless of grouping. */
  blended: SeriesResult;
  /** Per-group series, keyed by the group value; empty when `groupBy` is omitted. */
  groups: Record<string, SeriesResult>;
}

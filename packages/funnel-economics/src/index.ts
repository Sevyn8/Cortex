/**
 * `@cortex/funnel-economics`: a pure, vertical-neutral compute library for
 * funnel economics (per-stage cost, CVRs, drop-off, survival, running cost,
 * wasted spend, gross and loss-adjusted CAC).
 *
 * Per the V3-FUNNEL plane split (ADR-CAC-002), this package holds the
 * deterministic METRICS only. It has no I/O, no database, no insurance-specific
 * vocabulary, and no hardcoded stage list or stage count. The leverage ranking
 * (which leak to fix first) is an intelligence-plane judgment and lives
 * elsewhere, never here.
 */
export { computeFunnelEconomics } from './compute.js';
export { allocateCost } from './allocate.js';
export type {
  AllocationBasis,
  AllocationMode,
  CostLineInput,
  Denominators,
  FunnelEconomicsInput,
  FunnelEconomicsResult,
  FunnelStage,
  GroupingDimensions,
  RecoveryModel,
  SeriesResult,
  StageCount,
  StageKey,
  StageMetric,
} from './types.js';

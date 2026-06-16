/**
 * Golden fixture: Navnit-NIBPL baseline.
 *
 * Provenance: source CAC_Model_v1.xlsx, sheet ROI_Sensitivity, Baseline column
 * (operator-supplied). The workbook itself is confidential and is NOT committed
 * to this repo; only these derived values are pinned here. The funnel stage set
 * and keys follow docs/spec/v3/cac/insurance-cac-funnel-stages.md (the ratified
 * 8-stage model, ADR-CAC-002).
 *
 * Cost components (workbook ROI_Sensitivity baseline), which must sum to the
 * total acquisition cost; the split is read from the workbook, never invented:
 *   media spend                C5  = 5,000,000  (direct to impression)
 *   commission cost            C27 = 8,640,000  (direct to policy)
 *   underwriting (qual pool)   C28 = 3,360,000  (direct to qualified)
 *   KYC (leads)                C29 = 1,440,000  (direct to lead)
 *   other acquisition opex     C15 =   400,000  (allocated, equal)
 *   total acquisition cost     C30 = 18,840,000
 *
 * Expected outputs (workbook): gross CAC 7,850 (C33); clawback recovered
 * 864,000 (C36); net 17,976,000 (C37); loss-adjusted CAC 9,362.5 (C38).
 */
import type {
  CostLineInput,
  Denominators,
  FunnelStage,
  RecoveryModel,
  StageCount,
} from '../../src/index.js';

export const NAVNIT_STAGES: FunnelStage[] = [
  { n: 1, key: 'impression', canonical_event: 'impression', benchmark_step_cvr: null },
  { n: 2, key: 'click', canonical_event: 'click', benchmark_step_cvr: 0.015 },
  { n: 3, key: 'lead', canonical_event: 'lead_created', benchmark_step_cvr: 0.08 },
  { n: 4, key: 'contact', canonical_event: 'lead_contacted', benchmark_step_cvr: null },
  { n: 5, key: 'qualified', canonical_event: 'lead_qualified', benchmark_step_cvr: null },
  { n: 6, key: 'quote', canonical_event: 'quote_issued', benchmark_step_cvr: null },
  { n: 7, key: 'policy', canonical_event: 'policy_issued', benchmark_step_cvr: null },
  {
    n: 8,
    key: 'retained_13m',
    canonical_event: 'policy_retained_13m',
    benchmark_step_cvr: 0.9,
    derived: true,
  },
];

/** Navnit baseline counts (funnel-stages.md), 20,000,000 down to 1,920 retained. */
export const NAVNIT_COUNTS: StageCount[] = [
  { stage: 'impression', count: 20_000_000 },
  { stage: 'click', count: 300_000 },
  { stage: 'lead', count: 24_000 },
  { stage: 'contact', count: 16_000 },
  { stage: 'qualified', count: 9_600 },
  { stage: 'quote', count: 6_000 },
  { stage: 'policy', count: 2_400 },
  { stage: 'retained_13m', count: 1_920 },
];

/** The five workbook cost components, mapped to stages. They sum to 18,840,000. */
export const NAVNIT_COST_LINES: CostLineInput[] = [
  { id: 'media', stage: 'impression', amount: 5_000_000, mode: 'direct' },
  { id: 'kyc', stage: 'lead', amount: 1_440_000, mode: 'direct' },
  { id: 'underwriting', stage: 'qualified', amount: 3_360_000, mode: 'direct' },
  { id: 'commission', stage: 'policy', amount: 8_640_000, mode: 'direct' },
  // Other acquisition opex is a flat workbook input; spread equally to exercise
  // allocation. The split across stages does not change the total or the CAC.
  { id: 'opex', stage: 'impression', amount: 400_000, mode: 'allocated', basis: 'equal' },
];

export const NAVNIT_TOTAL_ACQ_COST = 18_840_000;

export const NAVNIT_DENOMINATORS: Denominators = {
  issuedStage: 'policy',
  retainedStage: 'retained_13m',
};

/**
 * Loss-adjusted recovery model:
 *   clawback_recovered = lapsed x premium x commission% x clawback%
 *                      =    480 x 18,000 x      0.20   x   0.50   = 864,000
 * lapsed = issued - retained = 2,400 - 1,920 = 480.
 */
export const NAVNIT_RECOVERY: RecoveryModel = {
  units: 480,
  factors: [18_000, 0.2, 0.5],
};

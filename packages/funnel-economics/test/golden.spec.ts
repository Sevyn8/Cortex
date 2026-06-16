import { describe, expect, it } from 'vitest';
import { computeFunnelEconomics } from '../src/index.js';
import {
  NAVNIT_COST_LINES,
  NAVNIT_COUNTS,
  NAVNIT_DENOMINATORS,
  NAVNIT_RECOVERY,
  NAVNIT_STAGES,
  NAVNIT_TOTAL_ACQ_COST,
} from './fixtures/navnit-baseline.js';

describe('golden fixture: Navnit-NIBPL baseline (CAC_Model_v1.xlsx)', () => {
  const result = computeFunnelEconomics({
    stages: NAVNIT_STAGES,
    counts: NAVNIT_COUNTS,
    costLines: NAVNIT_COST_LINES,
    denominators: NAVNIT_DENOMINATORS,
    recovery: NAVNIT_RECOVERY,
  });
  const series = result.blended;

  it('cost components sum to the workbook total (no invented split)', () => {
    const sum = NAVNIT_COST_LINES.reduce((acc, line) => acc + line.amount, 0);
    expect(sum).toBe(NAVNIT_TOTAL_ACQ_COST);
    expect(series.totalAcquisitionCost).toBe(NAVNIT_TOTAL_ACQ_COST);
  });

  it('reproduces the funnel counts 20,000,000 down to 1,920', () => {
    expect(series.stages.map((s) => s.count)).toEqual([
      20_000_000, 300_000, 24_000, 16_000, 9_600, 6_000, 2_400, 1_920,
    ]);
  });

  it('issued 2,400 and retained 1,920 from the named stages; lapsed 480', () => {
    expect(series.issued).toBe(2_400);
    expect(series.retained).toBe(1_920);
    expect(series.issued - series.retained).toBe(480);
  });

  it('clawback recovered ties out to 864,000', () => {
    expect(series.recoveredAmount).toBe(864_000);
  });

  it('gross CAC = 7850 to the cent', () => {
    expect(series.grossCac).toBeCloseTo(7850, 2);
    expect(series.grossCac).toBe(7850);
  });

  it('loss-adjusted CAC = 9362.5 to the cent', () => {
    expect(series.lossAdjustedCac).toBeCloseTo(9362.5, 2);
    expect(series.lossAdjustedCac).toBe(9362.5);
  });

  it('net acquisition cost ties out to 17,976,000', () => {
    expect(series.totalAcquisitionCost - series.recoveredAmount).toBe(17_976_000);
  });

  it('derives the same lapsed (480) when recovery.units is omitted', () => {
    const derived = computeFunnelEconomics({
      stages: NAVNIT_STAGES,
      counts: NAVNIT_COUNTS,
      costLines: NAVNIT_COST_LINES,
      denominators: NAVNIT_DENOMINATORS,
      recovery: { factors: [18_000, 0.2, 0.5] },
    });
    expect(derived.blended.recoveredAmount).toBe(864_000);
    expect(derived.blended.lossAdjustedCac).toBe(9362.5);
  });
});

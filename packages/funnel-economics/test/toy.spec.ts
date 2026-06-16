import { describe, expect, it } from 'vitest';
import { computeFunnelEconomics } from '../src/index.js';
import type { CostLineInput, FunnelStage, StageCount } from '../src/index.js';

/**
 * Stage-agnostic proof: a 3-stage toy funnel with arbitrary stage keys (a, b,
 * c) computes correctly, demonstrating there is no hardcoded stage count or
 * stage names. Also exercises direct + allocated(equal) allocation and the
 * derived metrics with hand-computed expected values.
 */
const STAGES: FunnelStage[] = [
  { n: 1, key: 'a', canonical_event: 'evt_a', benchmark_step_cvr: null },
  { n: 2, key: 'b', canonical_event: 'evt_b', benchmark_step_cvr: 0.5 },
  { n: 3, key: 'c', canonical_event: 'evt_c', benchmark_step_cvr: 0.2 },
];

const COUNTS: StageCount[] = [
  { stage: 'a', count: 100 },
  { stage: 'b', count: 50 },
  { stage: 'c', count: 10 },
];

const COST_LINES: CostLineInput[] = [
  { id: 'a-direct', stage: 'a', amount: 1000, mode: 'direct' },
  { id: 'b-direct', stage: 'b', amount: 500, mode: 'direct' },
  { id: 'c-direct', stage: 'c', amount: 200, mode: 'direct' },
  { id: 'flat', stage: 'a', amount: 300, mode: 'allocated', basis: 'equal' },
];

describe('3-stage toy funnel (stage-agnostic)', () => {
  const { blended } = computeFunnelEconomics({
    stages: STAGES,
    counts: COUNTS,
    costLines: COST_LINES,
    denominators: { issuedStage: 'b', retainedStage: 'c' },
    recovery: { units: 5, factors: [10, 0.5] },
  });

  it('allocates equal-basis cost across all stages; total preserved', () => {
    // flat 300 spread equally -> 100 per stage; direct on top.
    expect(blended.stages.map((s) => s.cost)).toEqual([1100, 600, 300]);
    expect(blended.totalAcquisitionCost).toBe(2000);
  });

  it('step CVR, drop-off, and cumulative survival', () => {
    expect(blended.stages.map((s) => s.stepCvr)).toEqual([null, 0.5, 0.2]);
    expect(blended.stages.map((s) => s.dropOff)).toEqual([0, 50, 40]);
    expect(blended.stages.map((s) => s.cumulativeSurvival)).toEqual([1, 0.5, 0.1]);
  });

  it('running cost over survivors', () => {
    // cumulative cost: 1100, 1700, 2000; over counts 100, 50, 10.
    expect(blended.stages.map((s) => s.runningCostPerSurvivor)).toEqual([11, 34, 200]);
  });

  it('wasted spend = previous running cost per survivor x drop-off', () => {
    // a: entry -> 0; b: 11 x 50 = 550; c: 34 x 40 = 1360.
    expect(blended.stages.map((s) => s.wastedSpend)).toEqual([0, 550, 1360]);
  });

  it('gross and loss-adjusted CAC over the named denominator stages', () => {
    // issued = count(b) = 50; retained = count(c) = 10; recovered = 5*10*0.5 = 25.
    expect(blended.issued).toBe(50);
    expect(blended.retained).toBe(10);
    expect(blended.recoveredAmount).toBe(25);
    expect(blended.grossCac).toBe(40); // 2000 / 50
    expect(blended.lossAdjustedCac).toBe(197.5); // (2000 - 25) / 10
  });
});

describe('groupBy (channel) partitions counts and cost lines', () => {
  const counts: StageCount[] = [
    { stage: 'a', count: 60, channel: 'x' },
    { stage: 'a', count: 40, channel: 'y' },
    { stage: 'b', count: 30, channel: 'x' },
    { stage: 'b', count: 20, channel: 'y' },
    { stage: 'c', count: 6, channel: 'x' },
    { stage: 'c', count: 4, channel: 'y' },
  ];
  const costLines: CostLineInput[] = [
    { stage: 'a', amount: 600, mode: 'direct', channel: 'x' },
    { stage: 'a', amount: 400, mode: 'direct', channel: 'y' },
    { stage: 'b', amount: 300, mode: 'direct', channel: 'x' },
    { stage: 'b', amount: 200, mode: 'direct', channel: 'y' },
  ];
  const result = computeFunnelEconomics({
    stages: STAGES,
    counts,
    costLines,
    denominators: { issuedStage: 'b', retainedStage: 'c' },
    groupBy: 'channel',
  });

  it('blended sums across groups', () => {
    expect(result.groupBy).toBe('channel');
    expect(result.blended.stages.map((s) => s.count)).toEqual([100, 50, 10]);
    expect(result.blended.totalAcquisitionCost).toBe(1500);
  });

  it('returns one series per channel with that channel only', () => {
    expect(Object.keys(result.groups).sort()).toEqual(['x', 'y']);
    const x = result.groups.x;
    const y = result.groups.y;
    expect(x?.stages.map((s) => s.count)).toEqual([60, 30, 6]);
    expect(y?.stages.map((s) => s.count)).toEqual([40, 20, 4]);
    expect(x?.totalAcquisitionCost).toBe(900); // 600 + 300
    expect(y?.totalAcquisitionCost).toBe(600); // 400 + 200
    expect(x?.grossCac).toBe(30); // 900 / 30
    expect(y?.grossCac).toBe(30); // 600 / 20
  });
});

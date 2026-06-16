/**
 * The funnel-economics primitive: a pure, vertical-neutral computation over a
 * stage set, per-stage counts, and allocated cost lines.
 *
 * It computes per-stage cost, step CVR, drop-off, cumulative survival, running
 * cost over survivors, wasted spend per stage, gross CAC, and loss-adjusted
 * CAC. It deliberately does NOT rank leaks or decide where to act: leverage
 * ranking is an intelligence-plane judgment (V3-A06), kept out of this metric
 * package per the V3-FUNNEL plane split (ADR-CAC-002).
 */
import { allocateCost } from './allocate.js';
import type {
  CostLineInput,
  Denominators,
  FunnelEconomicsInput,
  FunnelEconomicsResult,
  FunnelStage,
  RecoveryModel,
  SeriesResult,
  StageCount,
  StageMetric,
} from './types.js';

function orderedCountByStage(stages: FunnelStage[], counts: StageCount[]): Map<string, number> {
  const byStage = new Map<string, number>();
  for (const stage of stages) {
    byStage.set(stage.key, 0);
  }
  for (const entry of counts) {
    const current = byStage.get(entry.stage);
    if (current === undefined) {
      throw new Error(`count references unknown stage "${entry.stage}"`);
    }
    byStage.set(entry.stage, current + entry.count);
  }
  return byStage;
}

function computeSeries(
  stages: FunnelStage[],
  counts: StageCount[],
  costLines: CostLineInput[],
  denominators: Denominators,
  recovery: RecoveryModel | undefined,
  revenueWeights: Record<string, number> | undefined,
): SeriesResult {
  if (stages.length === 0) {
    throw new Error('stages must be non-empty');
  }

  const countByStage = orderedCountByStage(stages, counts);
  const countVec = stages.map((s) => countByStage.get(s.key) ?? 0);

  const perStageCost = allocateCost(stages, costLines, countByStage, revenueWeights);
  const totalAcquisitionCost = Array.from(perStageCost.values()).reduce((a, b) => a + b, 0);

  const entry = countVec[0] ?? 0;
  let cumulativeCost = 0;
  const runningPerSurvivor: number[] = [];
  const metrics: StageMetric[] = [];

  stages.forEach((stage, i) => {
    const count = countVec[i] ?? 0;
    const prev = i > 0 ? (countVec[i - 1] ?? 0) : null;
    const cost = perStageCost.get(stage.key) ?? 0;
    cumulativeCost += cost;

    const stepCvr = prev === null || prev === 0 ? null : count / prev;
    const dropOff = prev === null ? 0 : prev - count;
    const cumulativeSurvival = entry === 0 ? 0 : count / entry;
    const runningCostPerSurvivor = count === 0 ? 0 : cumulativeCost / count;
    runningPerSurvivor.push(runningCostPerSurvivor);
    const prevRunning = i > 0 ? (runningPerSurvivor[i - 1] ?? 0) : 0;
    const wastedSpend = prev === null ? 0 : prevRunning * dropOff;

    metrics.push({
      stage: stage.key,
      n: stage.n,
      count,
      cost,
      stepCvr,
      dropOff,
      cumulativeSurvival,
      runningCostPerSurvivor,
      wastedSpend,
    });
  });

  const issued = countByStage.get(denominators.issuedStage);
  if (issued === undefined) {
    throw new Error(`denominators.issuedStage "${denominators.issuedStage}" is not a known stage`);
  }
  const retained = countByStage.get(denominators.retainedStage);
  if (retained === undefined) {
    throw new Error(
      `denominators.retainedStage "${denominators.retainedStage}" is not a known stage`,
    );
  }

  let recoveredAmount = 0;
  if (recovery !== undefined) {
    const units = recovery.units ?? issued - retained;
    recoveredAmount = recovery.factors.reduce((acc, f) => acc * f, units);
  }

  const grossCac = issued === 0 ? 0 : totalAcquisitionCost / issued;
  const lossAdjustedCac = retained === 0 ? 0 : (totalAcquisitionCost - recoveredAmount) / retained;

  return {
    stages: metrics,
    totalAcquisitionCost,
    issued,
    retained,
    recoveredAmount,
    grossCac,
    lossAdjustedCac,
  };
}

/**
 * Compute funnel economics. Always returns the blended series (over all data);
 * when `groupBy` is supplied, also returns one series per distinct group value
 * on that axis. Grouping is first-class: counts and cost lines carry the
 * channel and cohort axes, and the same series computation runs per group.
 */
export function computeFunnelEconomics(input: FunnelEconomicsInput): FunnelEconomicsResult {
  const { stages, counts, costLines, denominators, recovery, revenueWeights, groupBy } = input;

  const blended = computeSeries(stages, counts, costLines, denominators, recovery, revenueWeights);

  const groups: Record<string, SeriesResult> = {};
  if (groupBy !== undefined) {
    const values = new Set<string>();
    for (const c of counts) {
      const v = c[groupBy];
      if (v != null) {
        values.add(v);
      }
    }
    for (const l of costLines) {
      const v = l[groupBy];
      if (v != null) {
        values.add(v);
      }
    }
    for (const value of values) {
      const groupCounts = counts.filter((c) => c[groupBy] === value);
      const groupLines = costLines.filter((l) => l[groupBy] === value);
      groups[value] = computeSeries(
        stages,
        groupCounts,
        groupLines,
        denominators,
        recovery,
        revenueWeights,
      );
    }
  }

  return { groupBy: groupBy ?? null, blended, groups };
}

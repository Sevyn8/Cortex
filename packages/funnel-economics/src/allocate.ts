/**
 * Cost allocation: turn a set of cost lines into per-stage cost totals.
 *
 * Pure. No stage names or stage count are assumed; everything is driven by the
 * supplied stage list and the cost lines' own stage references.
 */
import type { AllocationBasis, CostLineInput, FunnelStage } from './types.js';

/**
 * Allocate cost lines onto stages, returning a map of stage key to total cost.
 *
 * - `direct`: the whole amount lands on the line's assigned stage.
 * - `allocated` / `fixed`: the amount is spread across all stages by `basis`.
 *   `equal` spreads evenly; `volume` / `leads` / `customers` spread in
 *   proportion to the per-stage counts; `revenue` spreads in proportion to the
 *   supplied per-stage revenue weights. If the chosen basis weights sum to
 *   zero, the line falls back to an equal split so no cost is silently dropped.
 */
export function allocateCost(
  stages: FunnelStage[],
  costLines: CostLineInput[],
  countByStage: Map<string, number>,
  revenueWeights?: Record<string, number>,
): Map<string, number> {
  const stageKeys = stages.map((s) => s.key);
  const perStage = new Map<string, number>();
  for (const key of stageKeys) {
    perStage.set(key, 0);
  }

  const add = (key: string, amount: number): void => {
    const current = perStage.get(key);
    if (current === undefined) {
      throw new Error(`cost line references unknown stage "${key}"`);
    }
    perStage.set(key, current + amount);
  };

  for (const line of costLines) {
    if (line.mode === 'direct') {
      add(line.stage, line.amount);
      continue;
    }

    if (line.basis === undefined) {
      throw new Error(
        `cost line "${line.id ?? line.stage}" with mode "${line.mode}" requires a basis`,
      );
    }

    const weights = stageWeights(stageKeys, line.basis, countByStage, revenueWeights);
    const total = weights.reduce((acc, w) => acc + w, 0);

    if (total <= 0) {
      const share = line.amount / stageKeys.length;
      for (const key of stageKeys) {
        add(key, share);
      }
      continue;
    }

    stageKeys.forEach((key, i) => {
      const weight = weights[i] ?? 0;
      add(key, (line.amount * weight) / total);
    });
  }

  return perStage;
}

function stageWeights(
  stageKeys: string[],
  basis: AllocationBasis,
  countByStage: Map<string, number>,
  revenueWeights?: Record<string, number>,
): number[] {
  switch (basis) {
    case 'equal':
      return stageKeys.map(() => 1);
    case 'volume':
    case 'leads':
    case 'customers':
      return stageKeys.map((key) => countByStage.get(key) ?? 0);
    case 'revenue': {
      if (revenueWeights === undefined) {
        throw new Error("basis 'revenue' requires revenueWeights");
      }
      return stageKeys.map((key) => revenueWeights[key] ?? 0);
    }
  }
}

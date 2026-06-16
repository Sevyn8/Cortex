import { computeFunnelEconomics } from '@cortex/funnel-economics';
import type { CostLineInput } from '@cortex/funnel-economics';
import { describe, expect, it } from 'vitest';
import { COLD_START_COUNTS, INSURANCE_COST_ONTOLOGY, INSURANCE_FUNNEL } from '../src/index.js';

const OUT_OF_SCOPE = [
  'C025',
  'C033',
  'C034',
  'C035',
  'C037',
  'C040',
  'C041',
  'C044',
  'C045',
  'C053',
  'C057',
  'C058',
  'C064',
  'C066',
  'C067',
  'C068',
  'C069',
  'C081',
  'C082',
  'C083',
];

describe('cost ontology: 65 in-scope lines, all mapped to real stages', () => {
  const stageKeys = new Set(INSURANCE_FUNNEL.map((s) => s.key));

  it('assigns exactly 65 lines', () => {
    expect(INSURANCE_COST_ONTOLOGY).toHaveLength(65);
  });

  it('assigns no out-of-scope (L/E/C-only) line', () => {
    const ids = new Set(INSURANCE_COST_ONTOLOGY.map((l) => l.id));
    for (const id of OUT_OF_SCOPE) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it('every line maps to a known funnel stage key', () => {
    for (const line of INSURANCE_COST_ONTOLOGY) {
      expect(stageKeys.has(line.stage)).toBe(true);
    }
  });

  it('every non-direct line declares a basis (primitive requirement)', () => {
    for (const line of INSURANCE_COST_ONTOLOGY) {
      if (line.mode !== 'direct') {
        expect(line.basis).toBeDefined();
      }
    }
  });

  it('is consumable by the funnel-economics primitive (amounts joined at runtime)', () => {
    // Attach a nominal amount of 1 to each assignment to form CostLineInput[].
    const costLines: CostLineInput[] = INSURANCE_COST_ONTOLOGY.map((l) => ({ ...l, amount: 1 }));
    const { blended } = computeFunnelEconomics({
      stages: INSURANCE_FUNNEL,
      counts: COLD_START_COUNTS,
      costLines,
      denominators: { issuedStage: 'policy', retainedStage: 'retained_13m' },
    });
    // Allocation preserves the total regardless of direct vs spread.
    expect(blended.totalAcquisitionCost).toBeCloseTo(65, 6);
    expect(blended.stages).toHaveLength(INSURANCE_FUNNEL.length);
  });
});

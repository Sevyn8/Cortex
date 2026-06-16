import { computeFunnelEconomics } from '@cortex/funnel-economics';
import { describe, expect, it } from 'vitest';
import {
  COLD_START_COUNTS,
  COMPOSITE_BENCHMARKS,
  INSURANCE_FUNNEL,
  flaggableStageKeys,
} from '../src/index.js';

describe('cold-start defaults reproduce the sourced composites', () => {
  const { blended } = computeFunnelEconomics({
    stages: INSURANCE_FUNNEL,
    counts: COLD_START_COUNTS,
    costLines: [],
    denominators: { issuedStage: 'policy', retainedStage: 'retained_13m' },
  });

  const countOf = (key: string): number => {
    const stage = blended.stages.find((s) => s.stage === key);
    if (stage === undefined) {
      throw new Error(`stage ${key} not found`);
    }
    return stage.count;
  };

  it('lead_to_qualified composite is 0.55', () => {
    expect(countOf('qualified') / countOf('lead')).toBeCloseTo(
      COMPOSITE_BENCHMARKS.lead_to_qualified,
      6,
    );
    expect(countOf('qualified') / countOf('lead')).toBeCloseTo(0.55, 6);
  });

  it('qualified_to_policy composite is 0.30', () => {
    expect(countOf('policy') / countOf('qualified')).toBeCloseTo(
      COMPOSITE_BENCHMARKS.qualified_to_policy,
      6,
    );
    expect(countOf('policy') / countOf('qualified')).toBeCloseTo(0.3, 6);
  });

  it('13-month persistency composite is 0.90', () => {
    expect(countOf('retained_13m') / countOf('policy')).toBeCloseTo(
      COMPOSITE_BENCHMARKS.persistency_13m,
      6,
    );
    expect(countOf('retained_13m') / countOf('policy')).toBeCloseTo(0.9, 6);
  });
});

describe('placeholder design: null-benchmark stages are not flaggable', () => {
  const flaggable = flaggableStageKeys();
  const nullBenchmarkStages = INSURANCE_FUNNEL.filter((s) => s.benchmark_step_cvr === null).map(
    (s) => s.key,
  );

  it('the inserted middle stages contact and quote carry null benchmarks', () => {
    expect(nullBenchmarkStages).toContain('contact');
    expect(nullBenchmarkStages).toContain('quote');
  });

  it('no stage with a null benchmark is in the flaggable set', () => {
    for (const key of nullBenchmarkStages) {
      expect(flaggable).not.toContain(key);
    }
  });

  it('every flaggable stage has a non-null benchmark', () => {
    for (const key of flaggable) {
      const stage = INSURANCE_FUNNEL.find((s) => s.key === key);
      expect(stage?.benchmark_step_cvr).not.toBeNull();
    }
    // The real LEAK rule lands with the intelligence plane (ADR-CAC-002); this
    // only guards that placeholders never enter a flaggable set.
    expect(flaggable.sort()).toEqual(['click', 'lead', 'retained_13m']);
  });
});

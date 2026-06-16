# @cortex/funnel-economics

A pure, vertical-neutral compute library for funnel economics. Given a stage
set, per-stage counts, and allocated cost lines, it computes per-stage cost,
step CVR, drop-off, cumulative survival, running cost over survivors, wasted
spend per stage, gross CAC, and loss-adjusted CAC.

Design constraints (per the V3-FUNNEL plane split, ADR-CAC-002):

- No I/O, no database, no network. Pure functions over plain inputs.
- No insurance-specific vocabulary, no hardcoded stage list, and no hardcoded
  stage count. Stages arrive as the neutral `FunnelStage` shape from
  `@cortex/cac-types`; the issued and retained denominators are named by stage
  key, so the library never assumes which stages exist.
- Grouping is first-class: counts and cost lines carry the channel and cohort
  axes (`GroupingDimensions`), and the same series computation runs per group.
- It does NOT rank leaks or decide where to act. Leverage ranking is an
  intelligence-plane judgment (V3-A06) and lives elsewhere, never here.

```ts
import { computeFunnelEconomics } from '@cortex/funnel-economics';

const { blended, groups } = computeFunnelEconomics({
  stages,
  counts,
  costLines,
  denominators: { issuedStage: 'policy', retainedStage: 'retained_13m' },
  recovery: { factors: [premium, commissionRate, clawbackRate] },
  groupBy: 'channel',
});
```

## Build

Build package: emits `dist/` via `tsc -b tsconfig.build.json`. Tests run with
`vitest` (no database). The Navnit-NIBPL golden fixture ties out to the
`CAC_Model_v1.xlsx` baseline (gross CAC 7,850; loss-adjusted CAC 9,362.5).

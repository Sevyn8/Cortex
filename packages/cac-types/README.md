# @cortex/cac-types

Vertical-neutral domain shapes for the insurance CAC app. Per ADR-CAC-001 the
CAC product is an app (the Atlas V3-INS pack plus generic platform
capabilities), not a service, and per architecture-spec invariant 2 a new
vertical is a new pack with zero engine commits. This package therefore carries
only neutral shapes, never a concrete per-vertical stage list (ADR-CAC-002):

- The funnel stage SHAPE (`FunnelStage`, `StageKey`; what a stage is: number,
  key, canonical event, benchmark step CVR, cost-line group ref, derived flag).
  The ordered insurance stage list (the ratified 8-stage model) is pack content,
  authored in the pack, not here.
- The grouping-axis shape (`GroupingDimensions`, `ChannelKey`, `CohortKey`): the
  channel and cohort keys a fact may be grouped by. Values and cohort semantics
  are pack (Tier 2) and tenant (Tier 3) content, never enumerated here.
- The funnel transition shape (`FunnelTransition`) and the CAC KPI input shape
  (`CacKpi`; V3-INS-FR-003).
- `src/generated/`: interim local Zod stand-ins for the contracts-repo C2 facts
  `funnel_event` and `cost_line` (swappable when the contracts repo lands).

There is intentionally no health/server type, no `cac-engine`, no concrete
`FUNNEL_STAGES` list, and no `dim_channel_cohort` enumeration. The 8-stage model
and its benchmark step CVRs are defined in
`docs/spec/v3/cac/insurance-cac-funnel-stages.md` (see V3-FUNNEL.md, ADR-CAC-002).

## Build

Build package: emits `dist/` via `tsc -b tsconfig.build.json`. Import from the
root (`@cortex/cac-types`) or `@cortex/cac-types/generated`.

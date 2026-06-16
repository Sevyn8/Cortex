# @cortex/cac-types

Domain types for the insurance CAC app. Per ADR-CAC-001 the CAC product is an
app (the Atlas V3-INS pack plus generic platform capabilities), not a service,
so this package carries:

- The acquisition funnel (`FunnelStage`, `FunnelTransition`; V3-INS-FR-002, see
  `docs/spec/v3/cac/V3-FUNNEL.md`).
- The CAC KPI input shape (`CacKpi`; V3-INS-FR-003).
- `src/generated/` — types generated from the contracts repo (placeholder; the
  contracts repo does not exist yet).

There is intentionally no health/server type and no `cac-engine`. The funnel's
eighth stage and benchmark step CVRs are operator-supplied open items and are
not encoded here (see V3-FUNNEL section 4).

## Build

Build package: emits `dist/` via `tsc -b tsconfig.build.json`. Import from the
root (`@cortex/cac-types`) or `@cortex/cac-types/generated`.

# @cortex/insurance-cac-pack

The insurance-cac Atlas pack skeleton: pack CONTENT (Tier 2), not engine code.
It holds the concrete 8-stage insurance funnel, its cold-start benchmarks, the
65-line cost ontology, and a V3-PACK-FR-001 manifest. The concrete stage list
lives here, never in `@cortex/cac-types` (it was removed from shared types in
ADR-CAC-002 to keep invariant 2: a new vertical is a new pack, not an engine
commit). Stage objects conform to the neutral `FunnelStage` shape from
`@cortex/cac-types`, and the cost ontology uses the `@cortex/funnel-economics`
cost-line input shape, so the primitive consumes pack data directly.

## On-disk location and why

`services/industry/insurance-cac/`. The spec designates `services/industry` as
the pack registry area (V3-PACK), and it was an empty placeholder; this is the
first pack content landing there. The pnpm `services/*/*` workspace glob makes
it a normal workspace package, so it builds, typechecks, lints, and tests like
the others and is covered by the CAC gate.

## Validated artifact, not a loadable signed pack

No Atlas registry and no DIS loader exist yet (V3-PACK-FR-005). This pack is a
validated artifact plus fixtures and tests, not a signed, loadable pack. The
manifest `signature` is a placeholder; cosign signing and loader verification
(V3-PACK-FR-003) land with registry v0.

## What is authored, and the allocation-basis note

- Funnel: the 8 stages (impression, click, lead, contact, qualified, quote,
  policy, retained at 13 months), each with key, canonical event, cost-line
  group, `benchmark_step_cvr` (nullable), and the `derived` flag on retained.
- Benchmarks: sourced composites (lead_to_qualified 0.55, qualified_to_policy
  0.30, persistency 0.90). The inserted middle stages (contact, quote) ship
  `benchmark_step_cvr` null so a LEAK rule cannot fire on placeholder numbers.
- Cost ontology: the 65 G/I lines assigned to stages with an allocation mode and
  basis. The 20 L/E/C-only lines are out of scope and omitted.

Note on "allocation basis": the `FunnelStage` shape has no allocation-basis
field, and the funnel-economics primitive carries `basis` per cost line. So the
allocation basis is authored on the cost-ontology lines (`mode` plus `basis`),
not on the stage objects. Nothing is forced into the stage shape.

## Deferred V3-PACK-FR-001 fields

Skeleton carries the manifest tuple (id, version, engine-compat range, signature
placeholder) plus the funnel, cold-start benchmarks, and cost ontology. The
remaining V3-PACK-FR-001 contents (canonical schema, validation/quarantine
rules, full KPI definitions, dashboard templates, UI manifest and terminology,
media extraction rules, scoring rules, agent playbooks, reference/demo data,
embeddings snapshot) are deferred to later phases; see `DEFERRED_PACK_FIELDS`
in `src/manifest.ts` for the per-field reason.

## Build and test

`tsc -b tsconfig.build.json` emits `dist/`. `vitest` runs the acceptance tests
(no database): the cold-start defaults reproduce the sourced composites, no
null-benchmark stage is flaggable, the manifest carries the required fields, and
the cost ontology is consumable by the primitive.

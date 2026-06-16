# ADR-CAC-001: The Insurance CAC Product is an App, Not an Engine

**Status:** Proposed (ratify alongside the v3 ADRs at gate GR / G0)
**Date:** June 2026
**Deciders:** Amit (value swimlane) drafts; joint ratification with Sanjeev at the gate
**Context documents:** `docs/spec/v3/specification.md` section 12.2 (V3-INS), section 9.2 (V3-CONV), section 8.3 (V3-MEAS), section 4 (identity); `docs/spec/v3/architecture-spec.md` section 2.3, 2.6, section 4, section 5 invariants 1, 2, 3, 12; `docs/spec/v3/reconciliation.md` items 65, 70, 72 and section 5.4
**Companion decisions:** ADR-SCOPE-010 (DIS is the data plane), ADR-IDENTITY-001 (CM is the identity authority)

---

## Context

A prior scaffold (prompt R0a) created `apps/cac-engine`, a deployable per-vertical service, plus a bespoke `/cac` console module and a local route guard. That framing predates the v3 package and conflicts with it. v3 governs (reconciliation.md section 7.5).

In v3 the insurance product is a vertical expressed as an Atlas pack, not a service. "CAC" (Customer Acquisition Cost) is a KPI, not a runtime: `V3-INS-FR-003` defines CAC as attributable acquisition spend divided by issued policies, computed per channel, campaign, product, and period. The lever that moves it is the offline-conversion loop (`V3-CONV`, interaction plane), and the proof is measurement (`V3-MEAS`, analytics plane). Architecture-spec invariant 2 is explicit: a new vertical is a new pack with zero engine commits; invariant 12 puts product boundaries on the user's mental model and runtime boundaries on physics. A standalone `cac-engine` violates both.

## Decision

The insurance CAC product is an app, composed of two parts and nothing else:

1. The Atlas Insurance Distribution pack (`V3-INS`, specification.md section 12.2) as Tier-2 vertical content: canonical entities, the funnel definition, KPI definitions (including CAC), quarantine and scoring rules, extraction rules, compliance defaults, dashboard templates, and demo data.
2. Generic, vertical-neutral platform capabilities, already specified, that the pack binds to:
   - Data plane (DIS): ingestion, canonical mapping, entity resolution, bronze and replay, lineage.
   - Intelligence plane: rules evaluator producing `lead.scored` and kin (`V3-A06`).
   - Analytics and measurement: semantic layer, baseline CAC dashboards, value ledger and holdout (`V3-MEAS`).
   - Interaction plane: action ledger and policy gate (`V3-ACT`) and the offline-conversion loop (`V3-CONV`).
   - Experience plane: the six archetypes (notably funnel, dashboard, work queue) rendering pack content (`V3-UX01-FR-002`).

No per-vertical `cac-engine` service is built. No capability above is re-implemented under a CAC name.

## Consequences

- Invariant 2 holds: insurance functionality requires zero engine commits beyond the sanctioned archetype work (plan.md Gate G2).
- R0a is re-derived (see CAC_Build_Bible_v3): `apps/cac-engine` is retired; `packages/cac-types` is re-scoped to CAC-funnel, measurement, and insurance-pack domain types (the `cac-engine` framing is removed); the console CAC area becomes an archetype-driven pack experience surface rather than a bespoke module.
- The offline-conversion connectors, action ledger, policy gate, RBAC, and identity resolution are Customer Master's swimlane (Sanjeev), reached only through the frozen contracts (C1 token, C3 action ledger, C5 consent). Invariant 3 holds: no second identity or policy authority. The console guard is a CM C1-token integration seam, not a local policy.
- The funnel definition and its benchmark conversion rates are pack content; their normative home is reconciled in the V3-FUNNEL addition (see open item below).

### Open (does not block this decision)

- `CAC_Model_v1.xlsx` (the model workbook), `CAC_Build_Bible_v2.0` (the prior bible), and the eight-stage funnel with benchmark step CVRs are not present in this repo. They are operator-supplied inputs. This ADR records the product-shape decision only and invents none of that content.

## References

- `docs/spec/v3/specification.md` sections 12.2, 9.2, 8.3, 4
- `docs/spec/v3/architecture-spec.md` sections 2.3, 2.6, 4, 5 (invariants 1, 2, 3, 12)
- `docs/spec/v3/reconciliation.md` items 65, 70, 72; section 5.4 (planned Cortex TS services)
- `docs/spec/v3/cac/CAC_Build_Bible_v3.md`, `docs/spec/v3/cac/V3-FUNNEL.md`
- ADR-SCOPE-010, ADR-IDENTITY-001 (companion v3 re-baseline decisions)

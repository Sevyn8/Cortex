# ADR-CAC-002: Funnel reconciled to the 8-stage model; stage list relocated out of shared types

**Status:** Accepted (operator-ratified in the funnel-reconcile prompt; companion to ADR-CAC-001, which ratifies at gate GR / G0)
**Date:** June 2026
**Deciders:** Amit (value swimlane); ratified by the operator
**Context documents:** `docs/spec/v3/cac/insurance-cac-funnel-stages.md`; `docs/spec/v3/cac/insurance-cac-cost-stage-map.md`; `docs/spec/v3/cac/V3-FUNNEL.md`; `docs/spec/v3/specification.md` section 12.2 (V3-INS-FR-002); `docs/spec/v3/architecture-spec.md` section 5 invariant 2
**Companion decisions:** ADR-CAC-001 (the insurance CAC product is an app, not an engine)

---

## Context

ADR-CAC-001 left the funnel stage count as an open item (V3-FUNNEL section 4): the ratified spec defined seven stages (V3-INS-FR-002: lead received, contacted, qualified, quoted, proposal submitted, payment, issued), while the authoring input `docs/spec/v3/cac/insurance-cac-funnel-stages.md` defined a different eight-stage model (impression, click, lead, contact, qualified, quote, policy, retained at 13 months). These are not a count difference alone: the authoring model prepends the media stages (impression, click) and ends at a derived retention stage, and the cost-stage map and Navnit open-items docs already build on it.

In parallel, `@cortex/cac-types` shipped a concrete `FUNNEL_STAGES` constant (the seven insurance stages) on its public surface. A hardcoded per-vertical stage list in shared platform types is an architecture-spec invariant 2 leak (a new vertical should be a new pack with zero engine commits).

## Decision

1. The insurance acquisition funnel is the 8-stage model in `docs/spec/v3/cac/insurance-cac-funnel-stages.md`: impression, click, lead, contact, qualified, quote, policy, retained at 13 months (derived). The prior 7-stage model in spec and code is superseded. `V3-INS-FR-002` is updated to match.
2. `@cortex/cac-types` holds only vertical-neutral shapes: the funnel stage SHAPE (number, key, canonical event, benchmark step CVR, cost-line group ref, derived flag), the grouping-axis shape (a channel key and a cohort key a fact may be grouped by), the CAC KPI input shape, and interim `funnel_event` and `cost_line` fact schemas in `src/generated/`. The concrete `FUNNEL_STAGES` list is removed from the public surface; the ordered insurance stage list becomes pack content (Tier 2), authored in the pack skeleton (a later prompt). No channel values and no cohort semantics are enumerated, and there is no `dim_channel_cohort` enumeration; only the grouping-key shape exists.
3. V3-FUNNEL plane placement is ratified (the [verify] is resolved): funnel metrics (per-stage cost, CVRs, gross and loss-adjusted CAC, wasted spend) are deterministic computation living in a pure, vertical-neutral compute package (built later) bound by the analytics and semantic layer; the leverage ranking (which leak to prioritize, and the LEAK rule) is an intelligence-plane judgment (V3-A06), not part of the metric package.

## Consequences

- Invariant 2 holds: no per-vertical stage list in shared types; a new vertical adds a pack, not an engine commit.
- `FUNNEL_STAGES` had a single internal consumer (`funnelStageSchema` in the same file) and zero external importers across the repo; its removal is contained to `packages/cac-types/src/index.ts`. `funnelStageSchema` is re-expressed as the neutral stage-definition object, and funnel transitions reference pack-defined stage keys rather than a shared enum.
- The pack skeleton (later prompt) must author the 8-stage list with its benchmark step CVRs and cost-line groups from the two authoring docs.
- The interim `funnel_event` and `cost_line` Zod in `src/generated/` are local stand-ins, swappable for the real C2 spine-event contracts when the `sevyn8/contracts` repo lands (Phase R). They are the one exception to the do-not-hand-edit rule for that seam.
- Recorded per the spec-or-code drift rule (architecture-spec invariant 13): the divergence is reconciled in both spec and code in one change, not left uncommented.

## References

- `docs/spec/v3/cac/insurance-cac-funnel-stages.md`, `docs/spec/v3/cac/insurance-cac-cost-stage-map.md`
- `docs/spec/v3/cac/V3-FUNNEL.md` (section 2 plane placement, section 3 stages, section 4 resolved)
- `docs/spec/v3/specification.md` section 12.2 (V3-INS-FR-002)
- `docs/spec/v3/architecture-spec.md` section 5 (invariant 2)
- ADR-CAC-001 (companion v3 re-baseline decision)

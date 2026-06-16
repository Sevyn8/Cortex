# V3-FUNNEL: Insurance Acquisition Funnel (spec addition)

Version: draft-1 (June 2026)
Status: Plane placement (section 2) and the 8-stage model (sections 3 and 4) are ratified per ADR-CAC-002. Remains a proposed addition to specification.md pending fold-in by reference. Follows the spec-or-code drift rule.
Companions: specification.md section 12.2 (V3-INS), section 8 (analytics and measurement), section 10 (experience plane); ADR-CAC-001; CAC_Build_Bible_v3.md.

---

## 1. Purpose

Define the insurance acquisition funnel once, normatively, so stage transitions, the CAC KPI, dashboards, and measurement all draw from one definition. The funnel is the backbone of the CAC product (the headline KPI is computed across it) and must not be redefined per surface.

## 2. Plane placement (ratified)

The funnel spans planes; each part has one normative home. Ratified (the [verify] is resolved, ADR-CAC-002):

| Funnel concern                                   | Plane / owner                                          | Anchor                            |
| ------------------------------------------------ | ------------------------------------------------------ | --------------------------------- |
| Stage list, ordering, entry and exit definitions | Vocabulary (Atlas insurance pack content)              | V3-INS-FR-002                     |
| Stage-transition events as canonical facts       | Data plane (DIS spine facts)                           | V3-INS-FR-002, C2                 |
| Funnel metrics (per-stage cost, CVRs, CAC)       | Pure compute package (built later), bound by analytics | V3-INS-FR-003, section 8.1        |
| Leverage ranking (which leak to fix first)       | Intelligence plane (rules and judgment)                | V3-A06                            |
| Funnel rendering                                 | Experience (funnel archetype)                          | V3-UX01-FR-002                    |
| Benchmark step CVRs (cold-start targets)         | Pack reference data                                    | V3-PACK-FR-001 (benchmark values) |

Ratified decisions:

1. The funnel definition (stage list, ordering, entry and exit) is pack content (Vocabulary plane), not an engine screen or a new service. Invariant 2 holds.
2. The funnel METRICS (per-stage cost, step and composite CVRs, gross and loss-adjusted CAC, wasted spend) are deterministic computation. They live in a pure, vertical-neutral compute package (built in a later prompt) that the analytics and semantic layer binds to; they are not a service and are not in @cortex/cac-types.
3. The leverage RANKING (which leak to prioritize: gap-to-benchmark weighted by recoverable spend, and the LEAK rule) is an intelligence-plane judgment (V3-A06), not part of the metric package. Metrics and ranking are kept separate so deterministic metric fixtures stay clean.

Open only: whether V3-FUNNEL is folded into specification.md section 12.2 or kept as a standalone normative section.

## 3. Stage definition

The ratified funnel is the 8-stage model, defined canonically in docs/spec/v3/cac/insurance-cac-funnel-stages.md:

1. impression
2. click
3. lead
4. contact
5. qualified
6. quote
7. policy
8. retained at 13 months (derived)

This supersedes the prior 7-stage list (lead received, contacted, qualified, quoted, proposal submitted, payment, issued); V3-INS-FR-002 is updated to match (ADR-CAC-002). Each transition SHALL emit a canonical spine fact (entity ref, from-stage, to-stage, occurred_at, source, lineage) enabling funnel analytics and per-stage CVR computation. Stage keys are pack content (Tier 2); shared types (@cortex/cac-types) carry only the neutral stage shape, never the concrete list.

## 4. RESOLVED: stage count and benchmark CVRs

The 7-versus-8 stage reconciliation is ratified (ADR-CAC-002): the 8-stage model in section 3 is canonical, superseding the prior 7-stage list. The earlier concern (the ratified spec defined seven stages, and the prompt referenced eight) is closed by adopting the 8-stage model and updating V3-INS-FR-002.

Benchmark step CVRs are defined canonically in docs/spec/v3/cac/insurance-cac-funnel-stages.md: the sourced composites (lead-to-qualified 0.55, qualified-to-policy 0.30, 13-month persistency 0.90) are retained, and the placeholder per-stage splits ship as null (measured, not flagged) until set from real data, so no LEAK fires on invented numbers. The CVR skeleton previously left OPEN here is superseded by that doc. `CAC_Model_v1.xlsx` remains the operator-supplied source of the golden baseline counts and is not committed to this repo.

## 5. CAC over the funnel

CAC = attributable acquisition spend / issued policies (V3-INS-FR-003), computed per channel, campaign, product, and period. Per-stage CVRs locate where spend leaks; the measured CAC delta against a holdout (V3-MEAS-FR-002, V3-MEAS-FR-003) is the only figure platform communications may quote.

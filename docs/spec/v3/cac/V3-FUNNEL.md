# V3-FUNNEL: Insurance Acquisition Funnel (spec addition)

Version: draft-1 (June 2026)
Status: Proposed addition to specification.md, pending ratification. Marked [verify] where it extends or reconciles ratified text. Follows the spec-or-code drift rule: this is a draft for review, not yet incorporated by reference.
Companions: specification.md section 12.2 (V3-INS), section 8 (analytics and measurement), section 10 (experience plane); ADR-CAC-001; CAC_Build_Bible_v3.md.

---

## 1. Purpose

Define the insurance acquisition funnel once, normatively, so stage transitions, the CAC KPI, dashboards, and measurement all draw from one definition. The funnel is the backbone of the CAC product (the headline KPI is computed across it) and must not be redefined per surface.

## 2. Plane placement [verify]

The funnel spans planes; each part has one normative home. Proposed:

| Funnel concern                                   | Plane / owner                             | Anchor                            |
| ------------------------------------------------ | ----------------------------------------- | --------------------------------- |
| Stage list, ordering, entry and exit definitions | Vocabulary (Atlas insurance pack content) | V3-INS-FR-002                     |
| Stage-transition events as canonical facts       | Data plane (DIS spine facts)              | V3-INS-FR-002, C2                 |
| CAC and per-stage KPIs over the funnel           | Analytics (semantic layer, pack KPI defs) | V3-INS-FR-003, section 8.1        |
| Funnel rendering                                 | Experience (funnel archetype)             | V3-UX01-FR-002                    |
| Benchmark step CVRs (cold-start targets)         | Pack reference data                       | V3-PACK-FR-001 (benchmark values) |

Recommendation: the funnel definition is pack content (Vocabulary plane), not an engine screen or a new service. This keeps invariant 2 intact. Operator to ratify the placement and confirm whether V3-FUNNEL is incorporated into specification.md section 12.2 or kept as a standalone normative section.

## 3. Stage definition

The ratified spec (V3-INS-FR-002) defines seven stages:

1. lead received
2. contacted
3. qualified
4. quoted
5. proposal submitted
6. payment
7. issued

Each transition SHALL emit a canonical spine fact (entity ref, from-stage, to-stage, occurred_at, source, lineage) enabling funnel analytics and per-stage CVR computation.

## 4. OPEN (critical, Phase 2 path): eight-stage funnel and benchmark CVRs

The driving prompt references an eight-stage funnel with benchmark step conversion rates. Two facts:

- The ratified spec defines seven stages (section 3 above), not eight.
- No benchmark step CVRs exist in the spec, and `CAC_Model_v1.xlsx` (which would carry the ROI_Sensitivity funnel chain) is not present in this repo.

This is an operator decision and is on the Phase 2 critical path. It is recorded here as an open question and is NOT resolved by invention. Required from the operator:

1. Reconcile the stage count: confirm seven stages, or define the eighth stage (likely candidates to confirm, not assume: a distinct "lead validated / junk-filtered" step before contacted, or a "renewal / onboarded" step after issued). The eighth stage, if added, amends V3-INS-FR-002.
2. Supply the benchmark step CVRs from `CAC_Model_v1.xlsx`.

CVR table skeleton (to be filled from the workbook; cells left OPEN, not estimated):

| Transition                    | Benchmark CVR |
| ----------------------------- | ------------- |
| lead received -> contacted    | [OPEN]        |
| contacted -> qualified        | [OPEN]        |
| qualified -> quoted           | [OPEN]        |
| quoted -> proposal submitted  | [OPEN]        |
| proposal submitted -> payment | [OPEN]        |
| payment -> issued             | [OPEN]        |
| (eighth stage, if confirmed)  | [OPEN]        |

The Diagnostic LEAK rule (per the workbook) is to be specified once the workbook is supplied; it is not reproduced or approximated here.

## 5. CAC over the funnel

CAC = attributable acquisition spend / issued policies (V3-INS-FR-003), computed per channel, campaign, product, and period. Per-stage CVRs locate where spend leaks; the measured CAC delta against a holdout (V3-MEAS-FR-002, V3-MEAS-FR-003) is the only figure platform communications may quote.

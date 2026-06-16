# CAC Build Bible v3

Version: 3.0-draft-1 (June 2026)
Status: Build guide for the insurance CAC app. Subordinate to the v3 package (specification.md, architecture-spec.md, plan.md, reconciliation.md) and to ADR-CAC-001. Where this guide and the v3 package differ, the v3 package governs.
Supersedes: CAC_Build_Bible_v2.0. [OPEN] The v2.0 bible is not present in this repo; the supersession is recorded here so it is deliberate, but the v2.0 text could not be read to enumerate exactly what is retired. Operator to supply v2.0 or confirm it lives elsewhere.

---

## 1. What the insurance CAC product is

Per ADR-CAC-001: an app, not an engine. It is the Atlas Insurance Distribution pack (`V3-INS`) plus generic platform capabilities it binds to. "CAC" is the headline KPI (`V3-INS-FR-003`: attributable acquisition spend divided by issued policies, per channel, campaign, product, period), not a service. There is no `cac-engine`.

## 2. Capability map (pack content vs platform plane)

| Concern                                                                              | Where it lives                                                | Spec anchor                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------- |
| Canonical entities (Lead, Quote, Proposal, Policy, Interaction, Campaign, Agent ref) | Insurance pack (Tier 2)                                       | V3-INS-FR-001                |
| Funnel stages and transitions                                                        | Pack defines stages; transitions are spine facts              | V3-INS-FR-002, V3-FUNNEL     |
| CAC and supporting KPIs                                                              | Pack KPI definitions, computed by the semantic layer          | V3-INS-FR-003                |
| Quarantine / junk suppression                                                        | Pack rules over DIS quarantine                                | V3-INS-FR-004                |
| Lead scoring                                                                         | Pack scoring rules (A06 format), intelligence plane evaluator | V3-INS-FR-005, V3-A06        |
| Call extraction (intent, objection, callback)                                        | Pack extraction rules, DIS media pipeline                     | V3-INS-FR-006, V3-MED        |
| Compliance defaults (IRDAI window, DPDP purposes, DLT)                               | Pack rule packs (AC04), enforced at the policy gate           | V3-INS-FR-007, V3-ACT-FR-004 |
| Baseline CAC dashboards                                                              | Pack dashboard templates, dashboard archetype                 | section 8.1, V3-UX01-FR-002  |
| Value proof (CAC delta vs holdout)                                                   | Measurement: value ledger and holdout                         | V3-MEAS                      |
| The CAC lever (outcomes back to bidding)                                             | Offline-conversion loop, interaction plane                    | V3-CONV                      |
| Action execution, idempotency, kill switch                                           | Action ledger and policy gate (CM, Sanjeev)                   | V3-ACT                       |
| Identity, RBAC, consent reads                                                        | Customer Master via contracts C1, C5                          | ADR-IDENTITY-001             |

## 3. Swimlane and contract boundaries

- Amit (value): the pack, the semantic layer and dashboards, the rules evaluator, measurement, the experience archetypes, DIS ingestion and resolution.
- Sanjeev (trust): action ledger, policy gate, offline-conversion connectors, consent ledger, identity, audit. Reached only through the frozen contracts (C1 token, C3 action ledger, C5 consent). CM policy wins where responsibilities intersect.
- Gemini (induction workbench, V3-PACK-FR-010) is control-plane only and egresses solely through the A05 gateway; the key lives in Secret Manager bound to the console BFF service account.

## 4. Build phasing (from plan.md)

- Phase 1 (Atlas seed): pack contract, registry v0, bronze and replay, lineage, cost and TTFV telemetry. The insurance pack rides on this.
- Phase 2 (insurance pack and lead data product): insurance canonical schema via the workbench with the client's real files; lead and one insurer feed onboarded; quarantine tuned; entity resolution v1 with merge-review queue; work-queue archetype; semantic layer v1 and baseline CAC dashboards. Gate G2: baseline CAC published and client-acknowledged, zero engine commits.
- Phase 3 (intelligence and conversion loop): rules evaluator and `lead.scored`; fast path under 60 s; holdout and value ledger; offline-conversion connectors live on the real ledger and gate. Gate G3: first measured CAC delta from the value ledger against the holdout.

## 5. Re-derivation of R0a (what changed)

- Retired: `apps/cac-engine` (no per-vertical engine); the bespoke `/cac` and `/cac/admin` module framing.
- Re-scoped: `packages/cac-types` now hosts CAC-funnel, measurement, and insurance-pack domain types plus the contracts-generated seam; the `cac-engine` framing is removed.
- Kept and reframed: the console CAC area as an archetype-driven pack experience surface; the route guard as a CM C1-token integration seam (placeholder until the contract lands).

## 6. Open items (operator-supplied; not invented here)

1. CRITICAL (Phase 2 path): the eight-stage funnel definition and benchmark step conversion rates. The spec defines a seven-stage funnel (V3-INS-FR-002) with no benchmark CVRs; the workbook that would carry them is absent. See V3-FUNNEL for the reconciliation and the open question.
2. `CAC_Model_v1.xlsx`: the model source (ROI_Sensitivity funnel chain, the Diagnostic LEAK rule). Absent from the repo; operator-supplied. No figures from it are reproduced or fabricated here.
3. Insurance product brand name (plan.md Phase 0 / G0): unset. This guide uses the neutral "insurance" / `V3-INS` naming; a chosen brand renames the surface later.
4. CODEOWNERS handle and whether to add a CI job gating the CAC packages: see the re-derivation branch and section E of the pre-flight report.

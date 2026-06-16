# insurance-cac pack: Navnit-NIBPL data and decision checklist (pre-authoring)

Status: Open-items tracker for Phase 2 authoring. Every item here needs Navnit-NIBPL's real data or a Navnit-side confirmation; none can be resolved at a desk. Owner: Amit. Use as the agenda for the client data conversation.
Companions: docs/spec/v3/cac/insurance-cac-funnel-stages.md; docs/spec/v3/cac/insurance-cac-cost-stage-map.md; docs/spec/v3/cac/CAC_Build_Bible_v3.md

---

## How to read this

The two pack authoring inputs (funnel stages, cost-stage map) are complete as drafts, but several values are placeholders or judgment calls that only Navnit's actuals can settle. This is the single list of those, so the client conversation closes them in one pass rather than discovering them mid-build. Each item states what is needed, why it matters, and the fallback if Navnit cannot supply it yet.

## A. Funnel instrumentation (does the data even exist)

These decide whether a stage computes from real events or sits dark. Confirm before authoring; a stage with no event data computes as zero and must be marked not-yet-instrumented, not leaking.

| #   | Item                                                                                                   | Why it matters                                                                                     | Fallback if unavailable                                                                         |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | Can Navnit emit a `lead_contacted` event (the connect or speed-to-lead touch)?                         | Stage 4 (Contact) exists only if this event is fed. It is the core leak point the product targets. | Mark stage 4 not-yet-instrumented; funnel collapses lead to qualified until the event is wired. |
| A2  | Can Navnit emit a `quote_issued` event?                                                                | Stage 6 (Quote) depends on it; quote-to-bind is the second designed leak point.                    | Mark stage 6 not-yet-instrumented; collapses qualified to policy.                               |
| A3  | Is `policy_retained_13m` derivable from their data (policy issue date plus lapse or persistency feed)? | Stage 8 is the basis of loss-adjusted CAC, the headline metric.                                    | Use the cold-start persistency curve until 13 months of their data exist.                       |
| A4  | What are their canonical source headers for each stage event and cost line?                            | Drives the pack-to-canonical mapping (B2) and the corpus auto-suggest.                             | Author mapping against their first real file in the workbench.                                  |

## B. Benchmark step CVRs (placeholders to replace)

The composites are sourced (lead-to-qualified 0.55, qualified-to-policy 0.30, persistency 0.90); the per-stage splits below are placeholders that only multiply back to those composites. Replace with sourced or measured values.

| #   | Item                                             | Current placeholder              | Why it matters                                               | Fallback                                                                               |
| --- | ------------------------------------------------ | -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| B1  | Stage 4 lead-to-contact (connect rate) benchmark | 70.0% (assumption)               | Without it, LEAK cannot fire on the connect step.            | Keep null (measured, not flagged) until set from Navnit actuals or an industry source. |
| B2  | Stage 5 contact-to-qualified benchmark           | 78.6% (set to reconcile to 0.55) | Same.                                                        | Keep null; composite 0.55 still flags lead-to-qualified.                               |
| B3  | Stage 6 qualified-to-quote benchmark             | 65.0% (assumption)               | LEAK on quote issuance.                                      | Keep null.                                                                             |
| B4  | Stage 7 quote-to-policy benchmark                | 46.2% (set to reconcile to 0.30) | Same.                                                        | Keep null; composite 0.30 still flags qualified-to-policy.                             |
| B5  | Stage 2 CTR and Stage 3 landing CVR              | 1.5% and 8.0% (scenario inputs)  | These were workbook scenario inputs, not sourced benchmarks. | Confirm against Navnit paid-media data; else flag as assumption.                       |

## C. Cost-line assignment judgment calls (confirm or correct)

From the cost-stage map section 5. Each applied judgment beyond the workbook's explicit cost model.

| #   | Item                                                                                               | Current assignment    | Decision needed                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| C1  | C050 Proposal processing and issuance                                                              | Quote                 | Confirm whether issuance cost dominates; if so move to Policy or split the line.           |
| C2  | C085 Cost of non-converting leads and declines                                                     | Lead (leakage)        | If Navnit declines are underwriting-driven, move to Qualified.                             |
| C3  | C008 Affiliate commissions                                                                         | Lead                  | Confirm pay-per-lead vs pay-per-policy; if per policy, move to Policy.                     |
| C4  | C009 Influencer fees                                                                               | Click (only if used)  | Confirm whether Navnit uses influencer spend at all; drop if not.                          |
| C5  | C006, C007, C036 (shopping, app-install, reseller margin)                                          | Click and Policy      | Generic lines with low insurance relevance; set to zero for Navnit if unused.              |
| C6  | Fixed and allocated lines (C020, C021, C022, C024, C026, C049, C052, C055, C059, C060, C076, C084) | basis equal (default) | Confirm allocation basis per line (equal vs revenue vs volume); equal is the safe default. |

## D. Baseline and commercial (gate G2 artifacts)

These are not authoring inputs but are due in the same client window; capturing them is the G2 gate.

| #   | Item                                                          | Why it matters                                                                                                                              |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Baseline CAC by channel, captured and acknowledged in writing | Success metric 1; the value ledger measures realized delta against this. Must be captured before any improvement claim (BRD 5.1, 5.2).      |
| D2  | Holdout assignment method (random, geographic, propensity)    | The one open measurement decision before Phase 3; needed to make the delta defensible. Amit and Sanjeev plus Navnit data realities.         |
| D3  | Premium, margin, tenure, clawback terms for Navnit            | LTV and loss-adjusted CAC inputs; the workbook used illustrative values (premium 18000, margin 12 percent, tenure 6y, clawback 50 percent). |

## E. Resolution sequence

1. Items in A gate everything; resolve first (a stage with no event cannot be authored meaningfully).
2. Items in C are desk-confirmable with Navnit on a call; close them in the same session as A.
3. Items in B resolve either from an industry source now or from Navnit actuals after first ingestion; until then they stay null (measured, not flagged), which is the safe default already baked into the stage definitions.
4. Items in D are the G2 gate artifacts; D1 is the hard one (written baseline) and is the success criterion for the POC.

Nothing here blocks Phase 1 (the generic funnel-economics primitive and the pack skeleton with cold-start defaults). These block Phase 2 authoring against Navnit's real files and the G2 baseline.

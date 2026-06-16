# insurance-cac pack: canonical funnel stage definitions (vertical_config authoring input)

Status: DRAFT authoring input for Phase 2. Resolves the B4 critical-path gap. Composite CVRs and top-funnel anchors are sourced; the two inserted middle stages carry placeholder sub-splits pending real data. Owner: Amit.
Companions: ADR-CAC-001; CAC_Build_Bible_v3.md; V3-FUNNEL.md; CAC_Model_v1.xlsx

---

## Purpose

This is the canonical insurance funnel that the `insurance-cac` pack ships as Tier 2 content: an ordered stage set, each stage with the canonical event it keys off, the CAC_Master cost-line group allocated to it, an allocation basis, and a benchmark step conversion rate. It is the cold-start reference ("what good looks like") that every insurance tenant starts from. A tenant's actual step CVRs are measured from their own `funnel_event` facts and compared against these benchmarks; the gap is what the LEAK rule flags and the leverage ranking prioritizes.

The funnel-economics primitive (V3-FUNNEL) takes this set as a parameter and has no hardcoded stage count, so this 8-stage default is tenant-extensible (see section 4).

## 1. The eight stages

Counts shown are the Navnit-NIBPL baseline from CAC_Model_v1.xlsx, retained as golden-fixture reference. They are this tenant's current actuals, not the benchmark.

| #   | Stage          | Canonical event                 | Step CVR (from prior stage)               | Benchmark CVR | Source                                                                      | Navnit baseline count | Navnit baseline CVR |
| --- | -------------- | ------------------------------- | ----------------------------------------- | ------------- | --------------------------------------------------------------------------- | --------------------- | ------------------- |
| 1   | Impression     | `impression`                    | entry                                     | n/a           | n/a                                                                         | 20,000,000            | n/a                 |
| 2   | Click          | `click`                         | impression to click (CTR)                 | 1.5%          | ASSUMPTION (no insurance CTR in Benchmarks; blended display and search)     | 300,000               | 1.5%                |
| 3   | Lead           | `lead_created`                  | click to lead (landing CVR)               | 8.0%          | ASSUMPTION with ref (Google avg CVR 7.52%, Benchmarks sheet)                | 24,000                | 8.0%                |
| 4   | Contact        | `lead_contacted`                | lead to contact (connect rate)            | 70.0%         | ASSUMPTION (no source; depends on speed-to-lead, CAC_Master C075)           | 16,000                | 66.7%               |
| 5   | Qualified      | `lead_qualified`                | contact to qualified                      | 78.6%         | ASSUMPTION (set so 70.0% x 78.6% = 0.55 benchmark lead-to-qualified)        | 9,600                 | 60.0%               |
| 6   | Quote          | `quote_issued`                  | qualified to quote                        | 65.0%         | ASSUMPTION (no source)                                                      | 6,000                 | 62.5%               |
| 7   | Policy         | `policy_issued`                 | quote to policy                           | 46.2%         | ASSUMPTION (set so 65.0% x 46.2% = 0.30 benchmark qualified-to-policy)      | 2,400                 | 40.0%               |
| 8   | Retained (13m) | `policy_retained_13m` (derived) | policy to retained (13-month persistency) | 90.0%         | SOURCED (Diagnostic target 0.90; Benchmarks industry 87 to 88%, target 95%) | 1,920                 | 80.0%               |

## 2. What is grounded and what is not

Grounded (do not invent over these):

1. The top-funnel anchors (impressions, clicks, leads) and their counts come directly from the ROI sheet's funnel chain.
2. The composite benchmark rates are sourced from the Diagnostic sheet's target column: lead-to-qualified 0.55, qualified-to-policy 0.30, 13-month persistency 0.90. These are "what good looks like" and the workbench's with-loop scenario uses exactly these.
3. The Navnit baseline composites are the Diagnostic "your value" column: lead-to-qualified 0.40, qualified-to-policy 0.25, persistency 0.80. These reconcile to the golden-fixture counts.

Not grounded (placeholders pending real data):

1. Stages 4 (contact) and 6 (quote) did not exist in the workbook; the five-step model collapsed them. They are inserted because broker and corporate-agent insurance funnels leak at exactly these points (speed-to-lead connect, quote-to-bind), which is the product's reason to exist.
2. Their sub-split CVRs (the 70.0% / 78.6% across stages 4 to 5, and 65.0% / 46.2% across stages 6 to 7) are placeholders. Their only current constraint is that they multiply back to the grounded composites (0.55 and 0.30), so adding the stages refines the funnel without contradicting the golden fixtures. The real split comes from Navnit's `funnel_event` data once ingested, or from industry benchmarks if sourced before then.
3. CTR (stage 2) and landing CVR (stage 3) were scenario inputs in the workbook, not sourced benchmarks; treated as assumptions with the nearest available reference.

Resolution rule for unsourced benchmarks: where a benchmark CVR is a placeholder, the LEAK rule SHOULD NOT fire on that stage until a real benchmark is set; a stage with no benchmark is measured and displayed but not flagged. This prevents placeholder numbers from generating false LEAK signals in front of the client.

## 3. Cost-line allocation per stage

The pack author assigns each CAC_Master line a `funnel_stage`. The grouping below follows CAC_Master's own AIDA-stage, function, and applies-to fields plus the workbook's cost model (media direct to impression; KYC per lead; underwriting per qualified; commission per policy). Representative IDs shown; the full assignment is one column added to the 85-line cost ontology.

| Stage        | Cost-line group (representative CAC_Master IDs)                                                          | Allocation basis                                         |
| ------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1 Impression | Attention media: C002, C003, C004, C010, C017, C073; leakage C078, C079, C080                            | direct (media spend)                                     |
| 2 Click      | Interest acquisition: C001, C005, C006, C012, C013, C018, C019, C038; allocated martech C011, C014, C022 | direct plus allocated                                    |
| 3 Lead       | Lead capture and identity: C023, C042, C043; leakage C085                                                | per leads                                                |
| 4 Contact    | Outreach: C075 speed-to-lead and telecalling, C028 SDR                                                   | per leads                                                |
| 5 Qualified  | Qualification and risk: C046, C047, C048, C049, C056                                                     | per qualified                                            |
| 6 Quote      | Pre-sale and offer: C029, C065, C050 (partial)                                                           | per qualified                                            |
| 7 Policy     | Close and issuance: C027, C030, C031, C032, C039, C050, C051, C054, C061 to C063, C076, C077             | per customers (commission by customers x premium x rate) |
| 8 Retained   | Persistency and carry: C074 clawback recovery (negative), C071 cost of capital, C052                     | per retained customers                                   |

Attribution model: last-touch default (matches CAC_Master last-touch on agent and broker commission), pack-declared, tenant-overridable per V3-FUNNEL-FR-003.

Stage 8 is a derived stage: `policy_retained_13m` is not a raw ingested event but a temporal evaluation against the persistency model (B7), produced when a policy survives 13 months. The primitive treats it as the terminal survival stage so cumulative survival and running CAC flow through to retained, which is what loss-adjusted CAC divides by.

## 4. Tenant extensibility (Tier 3)

A tenant binding may extend or override this set without a pack edit and without an engine commit, per the resolution order (engine defaults, then pack, then tenant) and V3-FUNNEL-FR-001:

1. Add a stage: a client with a distinct stage this default collapses (for example a separate medical or tele-underwriting step, or a payment-confirmation step) declares it in tenant config with its position, the canonical event it keys off, and its cost-line group.
2. Override a benchmark CVR: a tenant may set its own benchmark targets where it has better reference than the pack default.
3. Bounds: a tenant stage must map to a canonical `funnel_event` type the tenant actually feeds; a stage with no event data computes as zero. "More stages" is bounded by "more events the tenant can supply."

The pack stays the reusable insurance vertical; Navnit-NIBPL-specific funnel shape lives in Navnit's Tier 3 config.

## 5. Illustrative vertical_config shape

Adapt to the real pack schema; structure is illustrative, field names confirmed against V3-PACK in Phase 2.

```
vertical_config:
  vertical: insurance
  funnel:
    stages:
      - n: 1, key: impression,           event: impression,           benchmark_step_cvr: null
      - n: 2, key: click,                event: click,                benchmark_step_cvr: 0.015   # assumption
      - n: 3, key: lead,                 event: lead_created,         benchmark_step_cvr: 0.080   # assumption
      - n: 4, key: contact,              event: lead_contacted,       benchmark_step_cvr: null     # placeholder, no flag
      - n: 5, key: qualified,            event: lead_qualified,       benchmark_step_cvr: null     # placeholder, composite 0.55 sourced
      - n: 6, key: quote,                event: quote_issued,         benchmark_step_cvr: null     # placeholder, no flag
      - n: 7, key: policy,               event: policy_issued,        benchmark_step_cvr: null     # placeholder, composite 0.30 sourced
      - n: 8, key: retained_13m,         event: policy_retained_13m,  benchmark_step_cvr: 0.90, derived: true   # sourced
    composite_benchmarks:        # sourced; used until per-stage splits are real
      lead_to_qualified: 0.55
      qualified_to_policy: 0.30
    attribution: last_touch
```

Note the deliberate choice: the inserted middle stages ship with `benchmark_step_cvr: null` so they do not flag against invented numbers, while the sourced composites are retained so LEAK still fires correctly on lead-to-qualified and qualified-to-policy until per-stage benchmarks are real.

## 6. Open items

1. Stage 4 and 6 per-stage benchmark CVRs: replace placeholders with sourced or measured values. Either find industry references for insurance connect-rate and quote-to-bind, or set them from Navnit's actuals after first ingestion. Until then they stay null (measured, not flagged).
2. CTR and landing CVR (stages 2 and 3): confirm against Navnit's real paid-media data; the workbook values were scenario inputs.
3. Confirm `lead_contacted` and `quote_issued` are events Navnit can actually supply; if not, those stages compute as zero and should be marked not-yet-instrumented rather than leaking.
4. Confirm the derived-stage handling for `policy_retained_13m` against the real temporal and persistency-model implementation in Phase 2 or 3.

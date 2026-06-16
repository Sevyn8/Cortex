# insurance-cac pack: cost-line to funnel-stage assignment (cost ontology authoring input)

Status: DRAFT authoring input for Phase 1 and 2. Takes the cost ontology from representative to complete. Owner: Amit. Review the judgment calls in section 5 before authoring.
Companions: docs/spec/v3/cac/insurance-cac-funnel-stages.md; docs/spec/v3/cac/CAC_Build_Bible_v3.md; docs/spec/v3/cac/V3-FUNNEL.md; CAC_Model_v1.xlsx

---

## Purpose and a correctness note

The funnel-economics primitive (V3-FUNNEL-FR-001 and FR-003) allocates each cost line to a funnel stage by a declared basis. This document assigns a `funnel_stage` and an allocation basis to every CAC_Master line that applies to insurance, so the eight-stage funnel (see docs/spec/v3/cac/insurance-cac-funnel-stages.md) has a complete cost model rather than a representative one.

Correctness note that governs the whole mapping: `funnel_stage` is per-vertical, therefore it is pack content (Tier 2), not a column on a shared Tier 1 ontology. Insurance stages do not transfer to a lending or electronics pack. The CAC_Master taxonomy and its attributes (function, AIDA stage, leakage flag, engine lever) are the shared reference; the stage assignment below is owned by the insurance-cac pack. A future lending pack assigns its own stages to the lending-applicable subset. Do not bake these insurance stage values into a shared table.

Scope: this assigns the 65 lines whose `applies to` contains G (generic) or I (insurance). The 20 lines that are exclusively L, E, or C are out of scope for this pack and are listed in section 4.

## 1. Assignment by stage

Allocation basis follows V3-FUNNEL-FR-003 (direct, allocated, or fixed; basis volume, leads, customers, equal, or revenue). Leakage lines feed wasted-spend and loss-adjusted math; they are flagged.

### Stage 1: Impression (event `impression`, basis: direct on media spend)

| ID   | Line item                       | Applies | Note                                         |
| ---- | ------------------------------- | ------- | -------------------------------------------- |
| C002 | Paid social                     | G       | Attention media                              |
| C003 | Display / programmatic          | G       | Attention media                              |
| C004 | Video / CTV / OTT               | G       | Attention media                              |
| C010 | Offline mapped to funnel        | G       | Attention media                              |
| C011 | Ad-serving / verification       | G       | allocated to media                           |
| C015 | Organic social mgmt             | G       | owned attention                              |
| C017 | PR / earned media               | G       | allocated, earned                            |
| C073 | Brand / ATL spend               | G       | allocated, leakage flag in workbook (in/out) |
| C078 | Ad fraud / IVT                  | G       | LEAKAGE                                      |
| C079 | Seasonality / auction inflation | G       | LEAKAGE                                      |
| C080 | Creative fatigue / refresh      | G       | LEAKAGE                                      |

### Stage 2: Click (event `click`, basis: direct plus allocated)

| ID   | Line item                       | Applies | Note                                    |
| ---- | ------------------------------- | ------- | --------------------------------------- |
| C001 | Paid search / SEM               | G       | interest acquisition                    |
| C005 | Retargeting                     | G       | interest                                |
| C006 | Shopping / PLA                  | G,E,C   | generic; low insurance relevance, see 5 |
| C007 | App-install ads / ASA           | G       | generic; low insurance relevance, see 5 |
| C012 | SEO tools / consultants         | G       | owned interest                          |
| C013 | Content marketing               | G       | owned interest                          |
| C016 | Webinars / events               | G       | interest                                |
| C018 | Creative production             | G       | allocated                               |
| C020 | Marketing salaries              | G       | FIXED, allocated (basis equal)          |
| C021 | Marketing agency retainer       | G       | FIXED, allocated (basis equal)          |
| C070 | Incremental vs measured CAC gap | G       | LEAKAGE, measurement                    |
| C072 | Measurement-degradation cost    | G       | LEAKAGE, allocated                      |

### Stage 3: Lead (event `lead_created`, basis: per leads)

| ID   | Line item                               | Applies | Note                                      |
| ---- | --------------------------------------- | ------- | ----------------------------------------- |
| C008 | Affiliate commissions                   | G       | paid per lead (insurance lead-gen)        |
| C014 | Email / lifecycle platform              | G       | allocated, lead nurture                   |
| C019 | Landing page / microsite                | G       | converts click to lead                    |
| C022 | MarTech stack (CRM/CDP)                 | G       | FIXED, allocated                          |
| C023 | 3rd-party / intent / enrich data        | G       | CPL, lead data                            |
| C024 | Consent / privacy tooling               | G       | FIXED, allocated, compliance              |
| C038 | Aggregator / comparison fees            | G,L,I   | CPL, aggregator leads (PolicyBazaar-type) |
| C042 | Identity / KYC verification             | G       | workbook: KYC per lead                    |
| C043 | CKYC / AML / video-KYC                  | L,I     | KYC per lead                              |
| C055 | Funnel infra / hosting                  | G       | FIXED, allocated (basis equal)            |
| C085 | Cost of non-converting leads / declines | G,L,I   | LEAKAGE, see 5 (could sit at Qualified)   |

### Stage 4: Contact (event `lead_contacted`, basis: per leads)

| ID   | Line item                   | Applies | Note                                           |
| ---- | --------------------------- | ------- | ---------------------------------------------- |
| C028 | SDR / inside sales          | G       | outreach                                       |
| C075 | Speed-to-lead / telecalling | L,I     | the connect-rate cost; product reason-to-exist |

### Stage 5: Qualified (event `lead_qualified`, basis: per qualified)

| ID   | Line item                                | Applies | Note                                            |
| ---- | ---------------------------------------- | ------- | ----------------------------------------------- |
| C046 | Underwriting on full pool (incl rejects) | L,I     | LEAKAGE (rejects); workbook: per qualified pool |
| C047 | Tele / medical underwriting              | I       | per qualified                                   |
| C048 | Inspection (motor/property/health)       | I       | per qualified                                   |
| C049 | Actuarial / risk allocation              | I       | FIXED, allocated                                |
| C056 | Fraud detection at acquisition           | G,L,I   | LEAKAGE, screens the pool                       |

### Stage 6: Quote (event `quote_issued`, basis: per qualified or per quote)

| ID   | Line item                      | Applies | Note                                               |
| ---- | ------------------------------ | ------- | -------------------------------------------------- |
| C029 | Pre-sales / demos / POC        | G       | pre-sale to offer                                  |
| C050 | Proposal processing / issuance | I       | proposal at quote; issuance spans to Policy, see 5 |
| C065 | First-premium discount / NCB   | I       | offer-stage incentive                              |

### Stage 7: Policy (event `policy_issued`, basis: per customers; commission by customers x premium x rate)

| ID   | Line item                           | Applies | Note                                    |
| ---- | ----------------------------------- | ------- | --------------------------------------- |
| C026 | Sales base + benefits               | G       | FIXED, allocated across sales stages    |
| C027 | Commission on new logos             | G       | per customer                            |
| C030 | Agent / advisor FY commission       | I       | per policy                              |
| C031 | Broker commission                   | I       | per policy                              |
| C032 | POSP payout                         | I       | per policy                              |
| C036 | Distributor / reseller margin       | G,E     | generic; low insurance relevance, see 5 |
| C039 | Bancassurance partner payout        | I       | per policy                              |
| C051 | Activation incentive                | G       | per policy                              |
| C054 | Payment gateway + first txn fee     | G       | first premium payment                   |
| C061 | Sign-up / welcome offer             | G       | conversion incentive                    |
| C062 | Cashback / first-purchase rebate    | G       | conversion incentive                    |
| C063 | Referral payout (both sides)        | G       | paid on conversion                      |
| C076 | Mis-selling training / monitoring   | I       | FIXED, allocated, compliance            |
| C077 | GST / TDS / irrecoverable input tax | G       | LEAKAGE; tax on premium and commission  |

### Stage 8: Retained at 13m (event `policy_retained_13m`, derived; basis: per retained customers)

| ID   | Line item                                | Applies | Note                                                             |
| ---- | ---------------------------------------- | ------- | ---------------------------------------------------------------- |
| C052 | Onboarding / CS allocation               | G       | FIXED, allocated; supports retention; LEAKAGE flag               |
| C071 | Cost of capital on upfront CAC           | L,I     | LEAKAGE, carry cost                                              |
| C074 | Commission clawback / persistency-linked | I       | LEAKAGE; recovery is negative cost, central to loss-adjusted CAC |

## 2. Cross-stage and fixed lines

Lines marked FIXED, allocated do not belong to one stage in substance; they are spread by the basis shown. The primitive allocates them per V3-FUNNEL-FR-003. Two lines are pure overhead and are allocated across all stages rather than placed:

| ID   | Line item                         | Applies | Handling                                                    |
| ---- | --------------------------------- | ------- | ----------------------------------------------------------- |
| C059 | G&A allocation to acquisition     | G       | FIXED, allocated across all stages (basis equal or revenue) |
| C060 | Regulatory allocation (RBI/IRDAI) | L,I     | FIXED, allocated across all stages                          |
| C084 | CapEx amortization of acq assets  | G,E,C   | FIXED, allocated (basis equal)                              |

## 3. Leakage lines summary (feed wasted-spend and loss-adjusted CAC)

C070, C071, C072, C073 (conditional), C074, C077, C078, C079, C080, C085, C052, C046 (reject portion), C056. These carry `leakage_flag` true and are the inputs to wasted-spend per stage and to the net-cost numerator of loss-adjusted CAC. C074 (clawback recovery) is the one negative line: it reduces net acquisition cost at the retained stage.

## 4. Lines not applicable to insurance (out of scope for this pack)

Exclusively L, E, or C; no funnel_stage assigned in the insurance-cac pack. Listed so the exclusion is explicit and auditable, not an oversight.

C025 (diagnostic try-on, C/E), C033 (DSA payout, L), C034 (in-shop demonstrators, E), C035 (beauty advisors, C), C037 (marketplace commission, E/C), C040 (co-lending, L), C041 (carrier/telco subsidy, E), C044 (credit-bureau pulls, L), C045 (field investigation, L), C053 (companion-app onboarding, E), C057 (first-order shipping, E/C), C058 (LOS, L), C064 (processing-fee waiver, L), C066 (no-cost-EMI, E), C067 (trade-in subsidy, E), C068 (GWP/gifting, C), C069 (sampling/sachets, C), C081 (chargebacks/COD-RTO, E/C), C082 (warranty/returns, E), C083 (sampling spoilage, C).

## 5. Judgment calls for review

These assignments applied judgment beyond the workbook's explicit cost model. Confirm or correct before authoring.

1. C050 Proposal processing and issuance spans two stages (proposal at Quote, issuance at Policy). Assigned to Quote. If issuance cost dominates, move to Policy or split the line.
2. C085 Cost of non-converting leads and declines: placed at Lead as a leakage line, but insurance declines occur largely at underwriting (Qualified). If Navnit's declines are underwriting-driven, move to Qualified.
3. C006, C007, C036 are generic (G) so they apply, but have low insurance relevance (shopping ads, app-install, reseller margin). Kept for completeness; set to zero for Navnit if unused, rather than removed from the ontology.
4. C008 Affiliate commissions assigned to Lead on the assumption insurance affiliates pay per lead. If they pay per policy, move to Policy.
5. C009 Influencer fees (Desire, G,E,C) is genuinely ambiguous for insurance and is not placed above; it sits at Click if used. Confirm whether insurance uses influencer spend at all.
6. Fixed and allocated lines (C020, C021, C022, C024, C026, C049, C052, C055, C059, C060, C076, C084): confirm the allocation basis (equal vs revenue vs volume) per line; the primitive needs a basis, and equal is the safe default where unsure.

## 6. How this is consumed

In Phase 1 and 2 this becomes one `funnel_stage` field plus an `allocation_basis` field on each line of the pack's cost-ontology data artifact (the productized form of CAC_Master). The funnel-economics primitive reads stage definitions (docs/spec/v3/cac/insurance-cac-funnel-stages.md) and these cost-line assignments together to compute per-stage cost, running CAC, and wasted spend. Tenant overrides (a client that allocates a line differently) live in Tier 3 config, not here.

# Cortex v3: Reconciliation of Spec v2.2 Against the Live Estate

Version: 1.0 (June 2026)
Status: Phase R working document; becomes an appendix of the v3 spec when ratified.
Suggested repo location: Cortex repo, docs/spec/v3/reconciliation.md

## 1. Method

Every v2.2 module receives one disposition:

1. SATISFIED-BY-LIVE: the live estate (DIS, Customer Master, dis-ui) already does this. The module's FRs are kept as conformance and gap tests against the live system; no new build.
2. ADOPT: a v2.2 idea the live estate lacks; build it as specified (possibly re-homed) on top of DIS / CM.
3. MERGE: v2.2 and the v3 design cycle independently specified the same thing; reconcile, keep the stronger of each part, keep the v2.2 module ID as lineage.
4. NEW-IN-V3: absent from v2.2; originates in the June 2026 design cycle.
5. CORTEX-NATIVE: stays in the Cortex repo as the edge product's scope.
6. DEFER: real, valuable, premature; parked with a named trigger.

Flag [verify]: disposition assigned from the module title and partial reading; confirm against full FR text and repo code during Phase R (Claude Code on TINA-HOME).

## 2. Module Disposition Register

### Foundation (F)

1. F01 Multi-Tenancy Infrastructure: SATISFIED-BY-LIVE for tenancy, RLS, and provisioning (CM + DIS). ADOPT the enterprise extensions as DIS roadmap: Mode B dedicated instances, per-tenant CMEK, quotas, BigQuery cost controls. [verify against repo F01 code: salvage as conformance tests]
2. F02 Tenant Lifecycle Manager: SATISFIED-BY-LIVE for provisioning. ADOPT offboarding, suspension, and legal hold (the unbuilt Slice C) into DIS / CM lifecycle. Repo Slices A and B: salvage logic as spec and tests. [verify]
3. F03 Temporal Data Engine: ADOPT into the DIS canonical store. Port the bi-temporal SQL migrations and the lint-bi-temporal script (first and best code salvage). Complementary to, not replaced by, the v3 bronze and replay design: bi-temporal answers "what did we believe when"; replay answers "re-derive with better rules".
4. F04 Configuration Plane: MERGE into Atlas (engine defaults, pack, tenant resolution order). [verify repo code reuse]
5. F05 Schema Evolution Engine: MERGE into Atlas pack SemVer plus replay-on-upgrade.

### Data (D)

6. D01 Canonical Data Model (three-tier ontology, gold KPI layer): MERGE into Atlas. Keep D01's tier rigor and gold-layer KPI definitions; Tier 2 retail extension becomes the Retail pack's schema content.
7. D02 Canonical Mapping Engine: SATISFIED-BY-LIVE (DIS mapping with date tokens); ADOPT any FRs beyond live behavior (auto-suggest already converges with the corpus design). [verify FR list]
8. D03 Data Contracts Framework: ADOPT into DIS (formal per-source expectations; pairs with drift detection).
9. D04 Data Quality Engine: ADOPT into DIS (profiling and quality scoring extending quarantine).
10. D05 Data Lineage and Provenance: ADOPT into DIS; use its FRs as the spec for the v3 lineage foundation.
11. D06 Polyglot Storage Layer: SATISFIED-BY-LIVE in substance (Postgres, GCS, BigQuery, pgvector); keep the engine-mapping table as reference.

### Identity and insight (I)

12. I01 Probabilistic Identity Registry (SIR): ADOPT as the DIS entity-resolution stage; its FRs are the design. CM remains adjudicator (ADR-IDENTITY-001).
13. I02 Knowledge Graph: DEFER. Trigger: entity resolution and cross-modal facts mature and a use case demands graph traversal.
14. I03 Multi-Source Conflict Resolution: ADOPT (survivorship rules inside the resolution stage).

### Gateway and pipelines (G)

15. G01 Universal Ingestion Gateway: SATISFIED-BY-LIVE core (Connect-a-System, SFTPGo, pull-workers, CSV). ADOPT the connector interface abstraction, per-source webhook URLs with HMAC, streaming mode (equals the v3 fast path), and the JDBC, Google Sheets, and generic REST connectors. Section 4.1a is superseded by ADR-SCOPE-010.
16. G02 Structured Data Pipeline: SATISFIED-BY-LIVE. [verify stage-by-stage against FRs]
17. G03 Document Understanding Pipeline: MERGE with the v3 media pipeline (images and documents track).
18. G04 Video Processing Pipeline: MERGE with the v3 media pipeline (video last).
19. G05 Audio Processing Pipeline: MERGE with the v3 media pipeline (audio first; ASR and diarization).
20. G06 IoT / Sensor Stream Pipeline: CORTEX-NATIVE adjacent; edge feeds arrive as canonical facts via the front door. DEFER any cloud-side IoT processing beyond that.

### Access and compliance (AC)

21. AC01 ABAC + RBAC Engine: SATISFIED-BY-LIVE by Customer Master (ADR-IDENTITY-001). FR gaps (notably ABAC attribute conditions) become CM backlog. [verify FR gap list with Sanjeev]
22. AC02 Hierarchy Engine: SATISFIED-BY-LIVE by CM fixed scopes; vertical display labels via pack i18n.
23. AC03 Consent and Privacy Manager: ADOPT into CM as the consent ledger (Sanjeev swimlane).
24. AC04 Compliance-as-Code Policy Engine: ADOPT as the rule format and authoring layer behind the interaction plane's policy gate (Sanjeev swimlane).

### Streaming and correlation (S)

25. S01 Stream Processing Engine: PARTIAL ADOPT (only what the fast path needs); full streaming engine DEFER.
26. S02 Cross-Modal Correlation Engine: DEFER. Trigger: media facts at volume plus a correlation use case.

### Industry and configuration (IC)

27. IC01 Industry Ontology Framework: MERGE; this is Atlas's module lineage. Keep IC01's package definition; add v3 distribution mechanics (signing, SemVer, corpus, registry) and the market name Atlas.
28. IC02 Localization and i18n Engine: ADOPT as the pack terminology layer.

### AI suite (A)

29. A01 Feature Store: DEFER to the first ML model phase; begin with features computed in-store. Trigger: model count over three or feature reuse pain.
30. A02 Algorithm Registry: MERGE into the v3 model registry (signing and engine-compat from the pack pattern).
31. A03 Decision Orchestration Engine: MERGE into the intelligence plane judgment pipeline. [verify FRs: adopt orchestration semantics if richer than v3 design]
32. A04 Model Lifecycle Manager: MERGE with the v3 eval harness and champion-challenger flow.
33. A05 LLM Gateway: ADOPT as the single generative choke point implementing invariant 8.
34. A06 Rule Engine: MERGE with the v3 rules evaluator; use A06 FRs as the spec.
35. A07 Explainability and Audit Service: MERGE with v3 lineage-backed explainability (why-this-score).
36. A08 Simulation and What-If Engine: DEFER to the prescriptive era. Trigger: measurement credibility established.

### Feedback and decision intelligence (FB)

37. FB01 Human-in-the-Loop Framework: MERGE with the v3 work-queue archetype and abstention policy; FB01 FRs inform queue semantics. [verify]
38. FB02 Decision-Outcome Linkage Engine: MERGE with the v3 measurement layer. Keep FB02's outcome-linkage plumbing; the holdout counterfactual and value ledger are v3 additions on top.
39. FB03 Decision Intelligence and Observability: MERGE with v3 drift and model monitoring.

### Output and integration (O)

40. O01 API Gateway and Integration Layer: PARTIAL SATISFIED (DIS API surface); ADOPT external API keys, rate limiting, and the developer-facing surface later (with SCR-18). [verify]
41. O02 Notification and Alert Engine: MERGE with the v3 notification fabric (interaction plane).
42. O03 Caching and Materialization Manager: DEFER. Trigger: dashboard latency or cost pain.

### Observability and economics (OB)

43. OB01 Platform Observability Stack: PARTIALLY LIVE (the built @cortex/observability package; DIS has its own). Salvage the package for all new TS services; align log and trace conventions across repos.
44. OB02 FinOps and Cost Management: MERGE with v3 cost-to-serve telemetry.
45. OB03 Metering and Billing Engine: ADOPT staged: metering events early (with cost telemetry), billing engine when outcome pricing is real.

### Edge (ED)

46. ED01 Edge-Cloud Orchestrator: CORTEX-NATIVE.
47. ED02 Edge Data Buffer and Sync: CORTEX-NATIVE.
48. ED03 Federated Learning Engine: DEFER indefinitely. Trigger: multi-site model privacy demand that pooled-with-consent cannot meet.

### Resilience, testing, privacy (RE, T, PR)

49. RE01 Disaster Recovery and BCP: ADOPT as posture and runbooks (asia-south2 per the design decisions log); no active-active build now.
50. T01 Platform Testing Framework: ADOPT the discipline (FR-numbered tests) across all repos; largely live in spirit.
51. PR01 Processing Purpose Registry: ADOPT (trust swimlane), BFSI phase.
52. PR02 Data Principal Portal and DSAR Pipeline: ADOPT (trust swimlane), BFSI phase; admin console SCR-23 with it.
53. PR03 Breach Detection and Response: ADOPT (trust swimlane), BFSI phase.
54. PR04 DPIA Workflow Engine: ADOPT-LATER within the compliance suite. [verify priority with Sanjeev]
55. PR05 DPA and Sub-Processor Registry: ADOPT-LATER, mostly process plus a small registry.
56. PR06 Retention Clock Service: ADOPT early in the media phase (pairs with GCS lifecycle and erasure).

### Embeddings and search (E)

57. E01 Embedding Pipeline: MERGE with the pgvector usage already designed (corpus, media, semantic search later).
58. E02 Semantic Search and Discovery: DEFER to the NL-surface phase (pairs with CX-05).

### Experience catalog (UX, W, SCR, CX, DX)

59. UX01 Screen Composition Engine: MERGE with the v3 experience resolution stack and archetypes.
60. W01 Tenant Onboarding Wizard: SATISFIED-BY-LIVE at source level (Connect-a-System); ADOPT the tenant-level wizard around it.
61. SCR-01 through SCR-24: RECAST as archetype-driven screens on the experience plane with swimlane owners. Live or in flight: SCR-08 (source wizard and ingestion health), SCR-09 (mapping studio). Amit's backlog: SCR-07, SCR-10, SCR-11, SCR-12, SCR-13, SCR-14 (deferred with A01), SCR-19 partly. Sanjeev's backlog: SCR-02, SCR-05, SCR-06, SCR-16, SCR-17, SCR-20, SCR-22, SCR-23. Shared or platform: SCR-01, SCR-03 (the workbench's vertical builder), SCR-04, SCR-18 (deferred), SCR-21 and SCR-24 (ops console). SCR-15 stays CORTEX-NATIVE.
62. CX-01 through CX-10: RECAST as Retail pack dashboard templates (pack content, not engine screens). CX-05 Ask Cortex: the NL surface, deferred phase. CX-03 Customer 360 builds on CM SSOT.
63. CX-DD-01 Shelf and Planogram Intelligence: CORTEX-NATIVE vertical extension, restructured as a pack over edge-fed facts.
64. DX01 SDK and Extensibility Platform: DEFER. Trigger: third-party integration demand.

### NEW-IN-V3 (no v2.2 ancestor or materially beyond it)

65. Offline-conversion CAC loop and ad-platform push connectors.
66. Action ledger semantics (states, idempotency, compensation) and runtime policy gate enforcement.
67. Holdout experimentation and the value ledger; auto-QBR; TTFV instrumentation.
68. Pack distribution mechanics: signing, SemVer, engine-compat declaration, corpus flywheel, registry.
69. Agent governance binding (agents as CM machine identities under the 4-tuple) and the abstention policy as invariant.
70. Insurance vertical pack and the market-gated phase plan.
71. Bronze raw retention and replay (complementing F03).
72. The one-engine / vertical-brands GTM doctrine as architecture law (zero engine commits test).

## 3. Draft ADR-SCOPE-010: DIS is the data plane

Extracted to docs/architecture/decisions/ADR-SCOPE-010-dis-is-the-data-plane.md (Status: Proposed; ratify at gate GR). The draft text is retained below.

Status: Proposed. Supersedes ADR-SCOPE-009 and spec v2.2 section 4.1a.
Context: v2.2 characterized DIS as "ROOS, Ithina's production platform", an external system to be consumed via a Kafka topic and never subsumed. Ownership facts: DIS and Customer Master are Sevyn8 products; Ithina is a tenant. DIS's real stack (Connect-a-System, SFTPGo, Pub/Sub, Postgres RLS, GCP asia-south1) also differs from the ROOS description. The boundary as written is drift.
Decision: DIS is Cortex v3's data plane. The consume-only boundary is retired. Cortex-repo modules dispositioned SATISFIED-BY-LIVE stop being built; their FRs become conformance tests against DIS. External partner systems still enter only through DIS's front door (the healthy half of 4.1a survives as front-door law).
Consequences: G01 / G02 / D02 build effort is redirected to the ADOPT list; the dis.golden.roos consumption pattern is repurposed as the template for edge Cortex feeding DIS; spec v2.2 text referencing ROOS ownership is corrected in v3.

## 4. Draft ADR-IDENTITY-001: Customer Master implements AC01, AC02, AC03

Extracted to docs/architecture/decisions/ADR-IDENTITY-001-customer-master-implements-ac01-ac02-ac03.md (Status: Proposed; ratify at gate GR). The draft text is retained below.

Status: Proposed; Sanjeev to ratify.
Context: v2.2 specifies AC01 (ABAC plus RBAC), AC02 (hierarchy), AC03 (consent) as Cortex modules. Customer Master is live and is the platform's identity SSOT with the Superadmin 4-tuple and fixed scope hierarchy.
Decision: Customer Master is the implementation of AC01 and AC02; AC03 is adopted into CM as the consent ledger. AC FRs are mapped against CM capability; gaps (expected: ABAC attribute conditions, consent ledger, agent machine identities) become CM backlog items, not new services. No second identity or policy authority is ever built.
Consequences: one identity authority (invariant 3); vertical display vocabulary handled by pack i18n over fixed scopes; the machine-auth token contract is the first artifact in the contracts repo.

## 5. Code salvage plan (Cortex repo)

1. Tag the repo v2-final before any re-scoping.
2. Run the existing redundancy-audit playbook (knip, ts-prune, jscpd, depcheck, madge) as the salvage audit in Claude Code on TINA-HOME.
3. Salvage tiers: (a) port as-is: F03 bi-temporal SQL migrations and lint-bi-temporal script toward the DIS store; @cortex/observability and @cortex/event-bus for all new TS services; turbo, commitlint, husky, CI discipline for the whole estate. (b) salvage as spec and tests: F01 and F02 service logic re-expressed as conformance and gap tests against DIS / CM; FR-numbered tests retained. (c) archive in place: anything SATISFIED-BY-LIVE with no test value; nothing is deleted.
4. New TS services (Atlas registry and workbench, intelligence, measurement) are built in the Cortex repo under the v3 spec, reusing the salvaged packages.

## 6. Spec drift corrections for the v3 text

1. Replace section 4.1a and ADR-SCOPE-009 per ADR-SCOPE-010; keep the front-door-only rule.
2. Correct all ROOS / Ithina ownership references: DIS is Sevyn8's; Ithina is tenant-zero.
3. Replace AC01 / AC02 / AC03 build language with CM mapping per ADR-IDENTITY-001.
4. Re-home G03 / G04 / G05 under the DIS media pipeline; G01 connector additions under DIS.
5. Recast CX-01..10 as Retail pack content; CX-DD-01 as an edge-fed pack.
6. Add the NEW-IN-V3 modules (section 2, items 65 to 72) as first-class spec sections.

## 7. Estate and naming notes (June 2026)

Recorded while landing the v3 package, from read-only inspection of the live sibling repositories (Claude Code on TINA-HOME). These are decisions and facts, captured so they are deliberate rather than accidental.

### 7.1 Repo naming (deferred-rename chore)

`ithina-retail-dis` embeds a client (`ithina`) and a single vertical (`retail`) in its name, which contradicts ADR-SCOPE-010: DIS is a Sevyn8 multi-tenant product, not an Ithina retail system. The same client-plus-vertical prefix sits on the Customer Master family (`ithina-retail-admin-backend`, `ithina-retail-admin-infra`). Renaming the remotes, CI references, and Terraform references is a deliberate deferred chore, recorded here so it is a decision and not an accident. (`admin-frontend` has the opposite problem, a generic name with no product scope; it is folded into the same rename pass.)

### 7.2 ROOS clarification (twofold drift)

v2.2 conflated two systems: it labeled the external platform "ROOS (Ithina DIS)" and treated DIS as that external thing. DIS's own README establishes ROOS as a separate downstream recommendation engine that reads from DIS. The drift is therefore twofold: wrong ownership (DIS is Sevyn8's; Ithina is a tenant) and wrong identity (ROOS is not DIS; it is a DIS consumer). The surviving rule is unchanged: external systems, including ROOS, interact with the platform only through DIS's defined contract surfaces (front-door law; see ADR-SCOPE-010 and specification.md V3-G01-FR-001). This is also recorded in ADR-SCOPE-010's Context.

### 7.3 Acronym variance

DIS's own README expands the acronym as "Data Integration System", while some Sevyn8 docs say "Data Ingestion Service". The v3 documents standardize on "Data Integration System" (the product's own README is authoritative for its name). As of this landing no v3 document spells the acronym out (only "DIS" is used), so there is nothing to rewrite in existing v3 text; the standard governs any future spelled-out use. The DIS repo is not edited.

### 7.4 Actual-to-logical repo map

| Logical (v3)        | Actual repo(s)                                                                                | Notes                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cortex              | `Cortex` (this repo)                                                                          | New TS platform services, salvaged packages, edge; tagged `v2-final` at this landing.                                             |
| DIS (data plane)    | `ithina-retail-dis`                                                                           | Data Integration System; rename flagged in 7.1.                                                                                   |
| CM (identity plane) | `ithina-retail-admin-backend` (service) plus `ithina-retail-admin-infra` and `admin-frontend` | Customer Master: Auth0 identity, RBAC, hierarchy, audit, `identity_mirror` over the master DB; the rename flag covers the family. |
| contracts           | does not exist yet                                                                            | Created in Phase R per plan.md (shared, language-neutral schemas).                                                                |

### 7.5 Pre-v3 docs queued for Phase R

`docs/future-roadmap.md` (104 KB) and `docs/deviations.md` predate v3 and are queued for reconciliation against `docs/spec/v3/plan.md` during Phase R. Until that reconciliation lands, where they conflict with the v3 package, the v3 package governs.

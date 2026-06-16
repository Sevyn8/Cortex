# Cortex v3.0 Specification

Version: 3.0-draft-1 (June 2026)
Status: Engineering specification. Successor to cortex_v2.2.docx. Read with: brd.md (business contract), architecture-spec.md (plane model), reconciliation.md (module dispositions, ADR-SCOPE-010, ADR-IDENTITY-001), plan.md (phasing and gates).
Suggested repo location: Cortex repo, docs/spec/v3/specification.md
Recommendation: v3 onward, the spec lives as Markdown in the repo (diffable, reviewable in PRs, native to the Claude Code workflow and the spec-or-code drift rule). A docx export can be generated for external sharing on demand.

---

## 0. Document conventions

1. Requirement language: SHALL (mandatory), SHOULD (strong default, deviation needs a recorded reason), MAY (optional).
2. Numbering: new and amended requirements are V3-{MODULE}-FR-NNN. Unamended v2.2 requirements keep their original IDs (for example F03-FR-012) and are incorporated by reference.
3. Incorporation by reference: a module section marked CARRIED incorporates the corresponding v2.2 module's FRs in full, as either build requirements (disposition ADOPT or MERGE) or conformance tests against the live estate (disposition SATISFIED-BY-LIVE), subject to the amendments listed in that section. Where a v3 amendment conflicts with a v2.2 FR, the amendment governs.
4. Dispositions, owners, and phases per module are normative and come from reconciliation.md section 2 and plan.md.
5. Live estate: DIS (data plane), Customer Master (CM, identity plane), dis-ui (experience shell), edge Cortex. Ithina, TBS / Quest Retail, and Display Data are tenants.
6. Region: asia-south1 primary; asia-south2 DR posture. Repo conventions (conventional commits with module scopes, no AI co-author trailers, plan-mode for dis-ui, spec-or-code drift rule) apply to all work under this spec.

## 1. Design Decisions Log

Carried from v2.2 and still in force: GCP as primary cloud; PostgreSQL 15+ (bi-temporal range types, pgvector, RLS, JSONB); hybrid tenant isolation (shared schema with RLS standard, dedicated instance enterprise); retail as first vertical; asia-south1 / asia-south2.

New in v3:
| Decision | Choice and rationale |
| --- | --- |
| Scope re-baseline | ADR-SCOPE-010: DIS is the data plane; CM is the identity plane. v2.2 section 4.1a and ADR-SCOPE-009 are superseded. The front-door-only rule survives: external systems enter only through DIS ingestion. |
| Identity authority | ADR-IDENTITY-001: CM implements AC01 and AC02; AC03 is adopted into CM. No second identity or policy authority is ever built. |
| Vertical mechanism | Atlas packs (IC01 lineage, D01 three-tier ontology) with signed, SemVer'd distribution. New vertical equals new pack, zero engine commits. |
| Repositories | Four repos: Cortex (new TS platform services, salvaged packages, edge), DIS, CM, contracts (language-neutral schemas). No merge. CODEOWNERS enforces swimlanes. |
| Interface discipline | Six frozen contracts (section 3) are the entire inter-swimlane interface; changes only at gate boundaries. |
| Generative AI | All generative LLM access through the A05 gateway. Self-hosted deterministic inference is unrestricted in the data plane. Generative calls on tenant data require tenant opt-in and stay in-region. |
| Team model | Two engineers, service-ownership swimlanes (trust: Sanjeev; value: Amit), WIP limit of two active phases. |

## 2. Platform overview

Seven planes on one event spine. Identity (CM) and Data (DIS) are live. Vocabulary (Atlas), Intelligence, Interaction, and the Measurement extensions of Analytics are specified here. Experience is live as a shell and gains the archetype and resolution-stack layers. Edge Cortex narrows to the sensing product feeding DIS. The full narrative is architecture-spec.md; this document is the requirements catalog.

## 3. Contracts (normative interface definitions)

All contracts live in the sevyn8/contracts repo as JSON Schema or OpenAPI, SemVer'd. V3-CTR-FR-001: a service SHALL NOT depend on another swimlane's internals; only on these contracts. V3-CTR-FR-002: contract changes SHALL occur only at phase-gate boundaries; mid-phase needs are stubbed and logged.

1. C1 Machine-auth token: JWT issued by CM. Required claims: iss, sub (machine or agent identity id), tenant_id, scopes[] (4-tuple encoded), purpose (INGEST | MEDIA | AD_PUSH | AGENT), exp (max 1h), jti. Validation: signature against CM JWKS; no downstream re-validation of identity facts.
2. C2 Spine event envelope: event_id (UUIDv7), event_type, schema_version, tenant_id, occurred_at, produced_by, trace_id, payload. Every event_type has a versioned JSON Schema. Producers SHALL NOT publish unregistered versions.
3. C3 Action ledger API: POST /actions (propose), POST /actions/{id}/approve, GET /actions/{id}, GET /actions?state=. Defined fully in V3-ACT.
4. C4 Merge adjudication API: resolution proposes candidate merges with evidence and confidence; CM adjudicates and owns the resulting identity. Defined with I01 amendments.
5. C5 Consent query API: read-side check by (data_principal_ref, purpose, channel) returning ALLOW | DENY | UNKNOWN with policy version. Backed by AC03 in CM.
6. C6 Pack contract: defined fully in V3-PACK.

## 4. Identity plane (owner: Sanjeev)

### 4.1 AC01 ABAC + RBAC Engine. CARRIED, SATISFIED-BY-LIVE by CM.

v2.2 AC01 FRs apply as a conformance and gap suite against CM.
Amendments:
V3-AC01-FR-001 The FR gap analysis (expected gaps: attribute-condition evaluation, machine and agent principals) SHALL be produced in Phase 0 and become CM backlog items, not new services.
V3-AC01-FR-002 CM SHALL support machine and agent principals as first-class identities issuing C1 tokens, with scopes drawn from the existing 4-tuple (Action values VIEW / CONFIGURE / EXECUTE / APPROVE / OVERRIDE / AUDIT).

### 4.2 AC02 Hierarchy Engine. CARRIED, SATISFIED-BY-LIVE by CM.

v2.2 AC02 FRs apply as conformance.
V3-AC02-FR-001 Hierarchy scope types are fixed platform-wide. Vertical display vocabulary (Store vs Branch vs Dealership) SHALL be supplied by pack terminology (IC02) as i18n labels; RLS and isolation logic SHALL never vary by vertical.

### 4.3 AC03 Consent and Privacy Manager. CARRIED, ADOPT into CM.

v2.2 AC03 FRs apply as build requirements.
V3-AC03-FR-001 The consent ledger SHALL record (data_principal_ref, purpose from PR01 registry, channel, basis, granted_at, revoked_at, evidence_ref, policy_version) and serve C5 reads at under 50 ms p95.
V3-AC03-FR-002 Consent revocation SHALL propagate to the policy gate (V3-ACT) within 60 seconds and trigger retention review (PR06) where applicable.

### 4.4 AC04 Compliance-as-Code Policy Engine. CARRIED, ADOPT (rule authoring and format).

v2.2 AC04 FRs apply. Amendment: V3-AC04-FR-001 AC04 SHALL be the authoring and versioning layer for policy-gate rules (declarative, testable, tenant-scoped); runtime enforcement is V3-ACT's policy gate. Rule packs MAY ship inside Atlas packs (regulatory defaults per vertical, for example IRDAI outreach windows) and MAY be extended per tenant.

### 4.5 PR01 to PR06 privacy suite. CARRIED, ADOPT (phased; see plan.md Phase 5).

v2.2 FRs apply per module. Amendments:
V3-PR06-FR-001 Retention clocks SHALL govern media blobs via GCS lifecycle classes and SHALL be wired in the media MVP phase, not deferred to the privacy phase.
V3-PR02-FR-001 DSAR erasure SHALL reach: canonical store rows (anonymization or deletion per policy), bronze raw layer, media blobs and derivatives, and search or vector indexes; completion SHALL be evidenced in the audit log.

## 5. Data plane: DIS (owner: Amit)

### 5.1 G01 Universal Ingestion Gateway. CARRIED, SATISFIED-BY-LIVE core + ADOPT extensions.

v2.2 G01 FRs apply: the five ingestion modes, connector abstraction interface (G01-FR-010), and the Phase 0 connector list are conformance against DIS where live and build requirements where not (JDBC, Google Sheets, generic REST, per-source webhook URLs with HMAC verification).
Amendments:
V3-G01-FR-001 Section 4.1a is superseded by ADR-SCOPE-010. The surviving rule: external systems SHALL enter the platform only through DIS ingestion; no external system reaches internal services directly.
V3-G01-FR-002 Streaming mode SHALL include a hot-lead fast path: webhook receipt to scored-and-routed in under 60 seconds p95 (measured receipt timestamp to action-ledger proposal timestamp), monitored as an SLO with alerting.
V3-G01-FR-003 Edge Cortex deployments SHALL feed DIS as registered sources publishing canonical facts (footfall, dwell, shelf state) through the same front door, using the consumption pattern formerly specified for ROOS.

### 5.2 G02 Structured Data Pipeline. CARRIED, SATISFIED-BY-LIVE. v2.2 FRs as conformance. No amendments beyond V3-RPLY and V3-ER integration points.

### 5.3 D02 Canonical Mapping Engine. CARRIED, SATISFIED-BY-LIVE. v2.2 FRs as conformance.

V3-D02-FR-001 Mapping auto-suggest SHALL be powered by embeddings shipped inside the bound pack (V3-PACK) with local pgvector similarity; no runtime calls to the control plane.
V3-D02-FR-002 Every accepted mapping decision SHALL emit an anonymized corpus event (header pattern, source format, accepted canonical field, vertical) per V3-PACK-FR-012; never values.

### 5.4 D03 Data Contracts, D04 Data Quality, D05 Lineage. CARRIED, ADOPT into DIS. v2.2 FRs apply.

V3-D05-FR-001 Every canonical fact SHALL carry lineage: source_id, file or message ref, row or offset, pack version, mapping version, pipeline run id.
V3-D04-FR-001 Source schema drift (column add, remove, type change, header reorder) SHALL alert before quarantine volume exceeds 2x its trailing 7-day baseline.

### 5.5 F03 Temporal Data Engine. CARRIED, ADOPT into the DIS store. v2.2 FRs apply.

V3-F03-FR-001 The bi-temporal SQL migrations and lint-bi-temporal tooling from the Cortex repo SHALL be ported to the DIS store; bi-temporal columns SHALL be mandatory on designated fact and dimension tables (list maintained in the data-model doc) and optional elsewhere.
V3-F03-FR-002 Bi-temporal answers "what did we believe at time T"; replay (V3-RPLY) answers "re-derive with improved rules". Both SHALL coexist; replay outputs SHALL be written as new system-time versions, never destructive updates.

### 5.6 I01 Probabilistic Identity Registry. CARRIED, ADOPT as the entity-resolution stage. v2.2 I01 FRs apply.

Amendments:
V3-I01-FR-001 The stage SHALL normalize phone (E.164), email (case, plus-tag policy per tenant config), and name (transliteration-aware) before matching.
V3-I01-FR-002 Matches SHALL carry confidence; at or above the auto-merge threshold (default 0.95, tenant-configurable) merges proceed automatically; between review threshold (default 0.75) and auto threshold they SHALL route to the merge-review work queue; below review threshold no link is made.
V3-I01-FR-003 Merge execution SHALL go through C4: resolution proposes with evidence; CM adjudicates and owns the identity outcome. Merge and split decisions are auditable facts on the spine.
V3-I03 (conflict resolution) FRs apply as the survivorship rule set within this stage.

### 5.7 G03 / G04 / G05 media pipelines. CARRIED, MERGE into the DIS media pipeline. v2.2 FRs apply per modality with these governing amendments:

V3-MED-FR-001 Media ingestion SHALL use signed GCS upload URLs, telephony SFTP, and webhooks, authenticated via C1 tokens with purpose MEDIA.
V3-MED-FR-002 Raw media SHALL live only in tenant-prefixed GCS buckets with retention classes (PR06) and lifecycle (hot to Nearline to delete); blobs SHALL never enter the canonical store; only derived canonical facts cross to the spine.
V3-MED-FR-003 Extraction workers (audio: ASR with diarization; documents and images: OCR and vision on ONNX; video: frame sampling) SHALL apply extraction rules supplied by the bound pack and SHALL emit facts with confidence and lineage to the source asset.
V3-MED-FR-004 Data model: media_asset (asset_id, tenant_id, source_id, type, gcs_uri, checksum, captured_at, consent_ref, retention_class, status) and media_derivative (derivative_id, asset_id, kind, content_ref or inline, model_version, confidence, created_at), plus pgvector embeddings keyed by derivative.
V3-MED-FR-005 Media workers SHALL run on a separate fleet with separate SLOs and cost lines; a media load test SHALL demonstrate no degradation of the V3-G01-FR-002 fast-path SLO. Build order: audio, then images and documents, then video.

### 5.8 V3-RPLY Bronze and Replay. NEW. Owner: Amit. Phase 1.

Purpose: make canonical history re-derivable forever; protect the platform's past from the imperfection of today's packs.
V3-RPLY-FR-001 Every ingested payload (file, message, webhook body, media manifest) SHALL be retained immutably in a bronze layer (GCS, tenant-prefixed, checksummed) with the metadata needed to re-run mapping: source_id, received_at, original encoding, pack and mapping versions used.
V3-RPLY-FR-002 A replay SHALL re-derive canonical facts from bronze for a selected scope (source, date range, pack version) using a specified pack version, writing results as new system-time versions with a replay_run_id; original facts are superseded, never deleted.
V3-RPLY-FR-003 Replays SHALL be idempotent (same bronze plus same pack version yields byte-identical canonical rows) and this property is a Phase 1 gate test.
V3-RPLY-FR-004 Downstream consumers SHALL handle supersedence events (fact.superseded) without manual intervention.
Acceptance: a deliberate mapping fix replayed over 30 days of one source corrects history end to end, with dashboards reflecting corrected values and lineage showing both derivations.

## 6. Vocabulary plane: Atlas (owner: Amit)

### 6.1 IC01 / D01 / F04 / F05. CARRIED, MERGE into Atlas. v2.2 FRs apply: IC01 package definition, D01 three-tier ontology and gold KPI layer, F04 configuration resolution, F05 schema evolution.

Governing amendment: the pack is the unit of all of it. Tier 1 core ontology is engine-owned; Tier 2 vertical extension is pack content; Tier 3 is tenant configuration; resolution order is engine defaults, then pack, then tenant.

### 6.2 V3-PACK Pack Distribution and Registry. NEW. Phase 1 (registry v0), continuous thereafter.

Purpose: packs as signed, versioned, distributable artifacts with a compounding mapping corpus.
V3-PACK-FR-001 A pack SHALL contain: manifest (id, version, engine-compat range, signature), canonical schema (Tier 2, with PII classification per field), validation and quarantine rules, KPI and metric definitions, dashboard templates, UI manifest and terminology bundle (IC02), media extraction rules, scoring rules (A06 format), agent playbooks, reference and demo data, cold-start benchmark values, and an embeddings snapshot for mapping auto-suggest.
V3-PACK-FR-002 Packs SHALL be SemVer'd: major for breaking schema change (requires replay plan), minor for additive, patch for rules and templates.
V3-PACK-FR-003 Packs SHALL be signed (cosign) and verified by the loader before activation; unsigned or compat-violating packs SHALL be rejected.
V3-PACK-FR-004 Tenants SHALL pin pack versions; upgrades are explicit operations that MAY trigger replay (V3-RPLY).
V3-PACK-FR-005 Registry v0 SHALL be signed artifacts in GCS plus a DIS loader; the registry API (publish, list, fetch, yank) SHALL be defined so a standalone service can replace v0 without consumer changes.
V3-PACK-FR-010 The induction workbench (profiler, Gemini-assisted schema induction via the A05 gateway, human curation UI) SHALL exist in the control plane only; no workbench component SHALL touch tenant runtime data paths.
V3-PACK-FR-011 A human curation gate SHALL stand between corpus and pack: no corpus-derived change ships without explicit curator approval.
V3-PACK-FR-012 Corpus events SHALL contain only anonymized patterns (header names, formats, accepted mappings, vertical tag); never cell values; collection requires the MSA learnings clause and honors tenant telemetry tier (full, metadata-only, off).
Acceptance: Retail pack v0.1 is produced by extraction from live DIS code with zero behavioral regression; swapping pack versions on a test tenant requires zero engine commits; a tampered pack is rejected.

## 7. Intelligence plane (owner: Amit)

### 7.1 A06 Rule Engine. CARRIED, MERGE with the rules evaluator. v2.2 A06 FRs apply.

V3-A06-FR-001 Scoring rules SHALL be declarative (CEL or JSON Logic), shipped in packs, versioned, and unit-testable against golden fixtures; the engine SHALL ship exactly one evaluator.
V3-A06-FR-002 Evaluations SHALL publish judgments as spine facts (lead.scored and kin) carrying score, confidence, rule or model version, and factor breakdown for explainability (A07).

### 7.2 A02 / A04 model registry and lifecycle. CARRIED, MERGE. v2.2 FRs apply.

V3-A02-FR-001 Models are signed, SemVer'd artifacts declaring engine-compat, exactly like packs; packs reference models by name plus pinned version; CI SHALL reject references the deployed engine cannot serve.
V3-A04-FR-001 No model, rule set, or playbook version SHALL deploy without passing the eval harness: offline regression on per-vertical golden sets, then champion-challenger in production; promotion criteria are defined per artifact and recorded.
V3-A04-FR-002 Training is per-tenant by default; cross-tenant pooling SHALL require explicit consent recorded in AC03.

### 7.3 A03 Decision Orchestration. CARRIED, MERGE with the judgment pipeline; v2.2 FRs apply where richer than this section. [verify in Phase R]

### 7.4 A05 LLM Gateway. CARRIED, ADOPT. v2.2 FRs apply.

V3-A05-FR-001 The gateway is the sole egress for generative model calls platform-wide. It SHALL enforce: tenant opt-in flags for tenant-data prompts, in-region endpoints only, prompt and response logging with PII redaction, per-tenant cost metering (OB02), and purpose tags.

### 7.5 A07 Explainability. CARRIED, MERGE with lineage-backed explainability. v2.2 FRs apply.

V3-A07-FR-001 "Why did this entity score X" SHALL be answerable in product in under two minutes: contributing rule or model version, top factors, input facts with lineage.

### 7.6 FB01 Human-in-the-Loop. CARRIED, MERGE with V3-WQ and abstention.

V3-FB01-FR-001 Every judgment SHALL carry confidence; below the abstention threshold (per judgment type, pack-defaulted, tenant-tunable) the system SHALL NOT act and SHALL route to the appropriate work queue.

### 7.7 V3-AGNT Agent Governance. NEW. Phase 6.

Purpose: automate work safely; agents think here, act only through the interaction plane.
V3-AGNT-FR-001 Every agent SHALL be a CM machine identity with C1 tokens, scoped via the 4-tuple: EXECUTE within scope; actions classified high-impact require APPROVE by a human; OVERRIDE is human-only.
V3-AGNT-FR-002 Agent playbooks (goals, tool whitelist, action classes, escalation rules, prompts where generative) are pack content, versioned and eval-gated like models.
V3-AGNT-FR-003 Agents SHALL have no direct database writes and no direct connector access; every effect is an action proposed through C3 and subject to the policy gate.
V3-AGNT-FR-004 Per-agent budgets (actions per period, spend) and an instant kill switch SHALL exist; kill SHALL halt new proposals within 10 seconds.
V3-AGNT-FR-005 The first production agent SHALL be internal-facing (quarantine triage or telecalling QA, chosen at G5 on queue volumes).
Acceptance: 100 percent of agent effects traverse gate and ledger in a 2-week audit; abstention and kill paths demonstrated.

### 7.8 Deferred with triggers: A01 Feature Store (3+ models or feature reuse pain), A08 Simulation (measurement credibility), I02 Knowledge Graph, E02 Semantic Search (NL-surface phase), ED03 Federated Learning.

## 8. Analytics plane (owner: Amit)

### 8.1 Semantic layer and dashboards. LIVE base. CX-01 through CX-10 are RECAST as Retail pack dashboard templates (pack content). CX-05 (Ask Cortex) is the NL surface, deferred phase; when built it SHALL compile to governed semantic-layer queries only (never raw SQL), RLS-scoped via CM context.

### 8.2 FB03 / D04 monitoring. CARRIED, MERGE. v2.2 FRs apply.

V3-FB03-FR-001 Model calibration SHALL be tracked in production (do 80-score leads convert at materially higher rates than 20-score leads); miscalibration beyond threshold alerts and can trigger challenger evaluation.
V3-MON-FR-001 A tenant-visible pipeline health page SHALL show ingestion freshness, volume anomalies, quarantine rate, and SLO status.

### 8.3 V3-MEAS Measurement. NEW (FB02 is the nearest ancestor; its outcome-linkage FRs apply underneath). Phase 3 onward.

Purpose: prove value with counterfactuals; measurement is also pricing infrastructure.
V3-MEAS-FR-001 Baselines SHALL be captured at onboarding per pack KPI definitions and acknowledged by the client in writing (gate G2 artifact).
V3-MEAS-FR-002 Holdouts: a configurable percentage of eligible units (leads or customers, stratified by channel) SHALL be excluded from treatments (scoring-driven routing, journeys, offline-conversion optimization effects where excludable) to serve as the counterfactual; assignment is deterministic, logged, and tamper-evident.
V3-MEAS-FR-003 The value ledger SHALL record per tenant per period: baseline, treated and holdout outcomes, computed deltas with confidence intervals, and metering counters (OB03 events). Platform communications SHALL NOT quote non-holdout deltas.
V3-MEAS-FR-004 TTFV instrumentation SHALL emit funnel events: tenant created, first source connected, first canonical rows, first dashboard insight viewed, first routed lead; targets are pack-defaulted.
V3-MEAS-FR-005 An auto-QBR document SHALL be generated monthly per tenant from the ledger: value realized, health, recommendations.
Acceptance: G3's first measured CAC delta is produced solely from ledger plus holdout; an auditor can reproduce the number from logged events.

### 8.4 OB01 / OB02 / OB03. CARRIED. OB01: salvage @cortex/observability for TS services; align conventions with DIS. OB02 MERGE with cost telemetry: V3-OB02-FR-001 cost SHALL be attributable per tenant and per unit (event, ASR minute, inference, ad-API call) from Phase 1 skeleton onward. OB03 ADOPT staged: metering events early; billing engine when outcome pricing is real.

## 9. Interaction plane (owner: Sanjeev)

### 9.1 V3-ACT Action Ledger and Policy Gate. NEW (ancestors: SCR-17, O01, AC04). Phase 2 build, Phase 3 live.

Purpose: the only place actions happen; integrity over speed.
V3-ACT-FR-001 Every outbound effect (ad-platform push, message, CRM webhook, notification) SHALL exist as an action record with states PROPOSED, APPROVED (when required), EXECUTING, EXECUTED, CONFIRMED, FAILED, COMPENSATED; transitions are append-only and audited (SCR-20 backing store).
V3-ACT-FR-002 Data model: action(action_id UUIDv7, tenant_id, type, payload_ref, idempotency_key, proposed_by (human, service, or agent identity), policy_decisions[], state, timestamps per transition, connector_id, external_ref, error).
V3-ACT-FR-003 Idempotency: connectors SHALL deduplicate on idempotency_key such that retries and replays cause zero duplicate external effects; this is the G3 zero-duplicate criterion.
V3-ACT-FR-004 The policy gate SHALL evaluate, pre-execution: consent (C5), DND and DLT status, frequency caps (per principal per channel per window), regulatory windows (IRDAI hours per AC04 rule packs), per-proposer budgets, and kill switches; every decision (allow or deny with reasons) is recorded on the action.
V3-ACT-FR-005 Kill switches SHALL exist at tenant, connector, and proposer (agent) scope, halting execution within 10 seconds.
V3-ACT-FR-006 Failed actions SHALL follow declared retry policies; non-retryable failures surface in the admin UI; compensation paths are defined per action type where reversal is meaningful.
V3-ACT-FR-007 Connector certification: a connector SHALL NOT serve production until it passes sandbox conformance, supports dry-run, and declares rate limits enforced by the gate.
Acceptance: chaos test replaying duplicate proposals and connector timeouts yields zero duplicate external effects; full audit reconstruction of any action's lifecycle.

### 9.2 V3-CONV Offline Conversion Loop. NEW. Phase 3.

Purpose: the headline CAC lever; outcomes back to bidding.
V3-CONV-FR-001 Issued outcomes (policy issued, sale completed) arriving as canonical facts SHALL be mapped to ad-platform conversion payloads: Google Enhanced Conversions for Leads and Meta Conversions API, with platform-required normalization and SHA-256 hashing of matching identifiers; raw identifiers SHALL NOT leave the platform unhashed.
V3-CONV-FR-002 Conversion sends are actions under V3-ACT with idempotency_key derived from (tenant, platform, outcome fact id); late-arriving issuance (T+3 to T+15) is supported via configurable lookback windows.
V3-CONV-FR-003 Consent and eligibility SHALL be checked per send (C5); holdout-assigned units are excluded per V3-MEAS-FR-002 policy.
V3-CONV-FR-004 Send results (accepted, rejected, match rate where reported) SHALL be recorded for measurement and troubleshooting.
Acceptance: two-week production window on both platforms with zero duplicates and reconciled send counts.

### 9.3 O02 Notification and Alert Engine. CARRIED, MERGE with the notification fabric. v2.2 FRs apply.

V3-O02-FR-001 Persona digests (for example branch-manager WhatsApp daily summary) and threshold alerts SHALL draw content from the semantic layer and send through V3-ACT-governed channels with per-persona preferences.

### 9.4 Journeys and routing. Phase 3 onward. WhatsApp journeys (DLT-registered) and scored lead routing into client CRMs are action proposers composing through C3; journey logic is Amit's swimlane (content and triggers), execution governance Sanjeev's.

## 10. Experience plane (owner per screen; engine: Amit)

### 10.1 UX01 / W01. CARRIED, MERGE. v2.2 FRs apply.

V3-UX01-FR-001 UI variation resolves engine defaults, then pack UI manifest and terminology, then tenant theme tokens, flags, and label overrides; tenants SHALL never override schema or rules.
V3-UX01-FR-002 The engine SHALL provide six screen archetypes: list, detail, wizard, dashboard, funnel, work queue; archetype content renders from pack schema; archetypes own layout.

### 10.2 V3-WQ Work Queue Archetype and Ground Truth. NEW. Phase 2.

V3-WQ-FR-001 The work queue archetype SHALL provide claim, decide (configurable verdicts), defer, and audit semantics with SLA timers and assignment rules.
V3-WQ-FR-002 Every decision SHALL emit label.captured on the spine (entity ref, verdict, decider identity, queue, latency) as training ground truth; labeling is a side effect of normal work, never a separate task.
V3-WQ-FR-003 First consumers: quarantine triage (SCR-10), merge review (SCR-11), then agent approvals and disposition capture.

### 10.3 Widget registry. V3-WGT-FR-001 Bespoke components SHALL live only in a versioned widget library; packs reference by name plus pinned version; CI SHALL reject references the deployed engine lacks. This is the sole code escape hatch from "packs are data".

### 10.4 SCR catalog. RECAST onto archetypes with owners (reconciliation section 2 item 61): live SCR-08, SCR-09; Amit's backlog SCR-07, SCR-10, SCR-11, SCR-12, SCR-13, SCR-19 (with O02); Sanjeev's backlog SCR-02, SCR-05, SCR-06, SCR-16, SCR-17, SCR-20, SCR-22, SCR-23; platform SCR-01, SCR-03 (workbench), SCR-04, SCR-21 and SCR-24 (ops console); deferred SCR-14 (with A01), SCR-18 (with DX01); CORTEX-NATIVE SCR-15.

## 11. Edge: Cortex sensing (owner: Amit; CORTEX-NATIVE)

ED01 and ED02 v2.2 FRs apply within the Cortex repo. V3-ED-FR-001 Edge deployments SHALL publish canonical facts to DIS via V3-G01-FR-003 as registered sources; edge devices receive detection and extraction configuration from packs once the registry graduates (V3-PACK-FR-005 consumer two). CX-DD-01 is restructured as a vertical pack over edge-fed facts. SCR-15 remains the device fleet surface.

## 12. Vertical pack specifications

### 12.1 Retail pack v0.x. Extracted from live DIS (Phase 1). Contents: existing retail canonical schema, validation rules, date-token configuration, KPI definitions (D01 gold layer for retail), dashboard templates recast from CX-01..CX-10, terminology bundle. Acceptance: extraction with zero behavioral regression (gate G1).

### 12.2 V3-INS Insurance Distribution pack v0.1. NEW. Phase 2.

V3-INS-FR-001 Canonical entities (Tier 2 over the core ontology): Lead, Quote, Proposal, Policy, InsurerFeedRecord, Interaction (call, message, visit), Campaign, Agent or Telecaller (referencing CM identities), with PII classification per field.
V3-INS-FR-002 Funnel stages (ratified 8-stage model, defined canonically in docs/spec/v3/cac/insurance-cac-funnel-stages.md): impression, click, lead, contact, qualified, quote, policy, retained at 13 months (derived); stage transitions are spine facts enabling funnel analytics. This supersedes the prior 7-stage list (lead received, contacted, qualified, quoted, proposal submitted, payment, issued); see ADR-CAC-002. The stage list is pack content (Tier 2), not engine code (invariant 2); shared types carry only the neutral stage shape.
V3-INS-FR-003 KPI definitions SHALL include: CAC equals attributable acquisition spend divided by issued policies, computed per channel, campaign, product, and period; junk-lead rate; speed-to-lead; quote-to-issue conversion; renewal rate placeholder.
V3-INS-FR-004 Quarantine rules: invalid mobile, duplicate within configurable window, blacklist, malformed insurer rows; each rule testable against fixtures.
V3-INS-FR-005 Scoring rules v1 (A06 format): source quality, product intent, recency, contactability, callback request; weights tenant-tunable within pack bounds.
V3-INS-FR-006 Extraction rules (audio): intent classification, objection tags, quote-discussed flag, callback commitment; outputs feed V3-INS-FR-005 features.
V3-INS-FR-007 Compliance defaults: IRDAI outreach window rule pack (AC04), DPDP consent purposes (PR01 entries), DLT template references.
V3-INS-FR-008 Demo tenant dataset and cold-start benchmarks ship in the pack.
Acceptance: gate G2 criteria; zero engine commits.

### 12.3 Automotive pack. Phase 6, authored through the workbench; spec section added when drafted. The dual-pack tenant (dealer plus motor insurance) is a normative test case: one tenant, two pack bindings, no namespace collisions, combined dashboards.

## 13. Non-functional requirements

| Concern             | Requirement                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fast path           | Webhook lead to routed action proposal under 60 s p95 (V3-G01-FR-002)                                             |
| Batch ingestion     | A 1 M-row file canonicalized within 30 min; quarantine isolation no worse than v2.2 G02 targets                   |
| Consent reads       | C5 under 50 ms p95                                                                                                |
| Policy gate         | Decision under 200 ms p95 per action                                                                              |
| Kill switch         | Effective within 10 s                                                                                             |
| Tenant provisioning | Conformance to F01 targets (Mode A under 5 min; Mode B under 30 min when built)                                   |
| Isolation           | RLS conformance suite green per release; media and structured fleet isolation proven by load test (V3-MED-FR-005) |
| Replay              | Idempotent re-derivation; 30-day single-source replay within 4 h                                                  |
| Availability        | 99.5 percent monthly for tenant-facing APIs initially; revisit at 10 tenants                                      |
| DR                  | asia-south2 posture per RE01: documented RTO 24 h, RPO 1 h via backups and bronze; no active-active               |
| Cost                | Per-tenant unit cost visible (V3-OB02-FR-001); media priced only after per-minute economics measured              |

## 14. Security and compliance requirements

1. Identity: all service and agent auth via C1 from CM; no shared secrets between swimlane services.
2. Isolation: RLS standard tier; dedicated-instance enterprise tier per F01 ADOPT items; per-tenant CMEK in the enterprise tier.
3. Data protection: PII classification from pack schema drives masking (experience), hashing (V3-CONV), redaction (A05 logs), and DSAR scope (PR02).
4. Generative AI: invariant 8 via the A05 gateway exclusively.
5. Audit: every identity-affecting, consent-affecting, and action-affecting event lands in the SCR-20 audit store, immutable, queryable by tenant compliance officers.
6. The BFSI review package (Phase 5) SHALL be assembled from this section plus live evidence, and pass a checklist dry run before any BFSI procurement.

## 15. Acceptance and gate cross-reference

GR and G0 through G6 criteria are normative in plan.md section 2; each gate's criteria reference FRs here (G1: V3-PACK-FR-001..005, V3-RPLY-FR-003; G2: V3-INS, V3-WQ, V3-I01; G3: V3-CONV, V3-ACT-FR-003, V3-G01-FR-002, V3-MEAS; G4: V3-MED; G5: V3-A07, V3-MON, A04 harness, security package; G6: automotive pack, V3-AGNT, A02/A04 promotion).

## 16. Glossary

Pack, corpus, spine, bronze, replay, judgment, abstention, action ledger, value ledger, work queue, TTFV: as defined in the platform glossary (source-of-truth v2.1 section 15), unchanged. Front door: Connect-a-System. Gate: a joint GO / NO-GO review per plan.md. Live estate: DIS, CM, dis-ui, edge Cortex as of June 2026.

## 17. Change control

This specification follows the drift rule: spec or code changes together, never apart; significant divergence requires an ADR in docs/architecture/decisions/. Amendments to CARRIED v2.2 FRs occur only in this document (v2.2 is frozen as historical record). FR IDs are never reused.

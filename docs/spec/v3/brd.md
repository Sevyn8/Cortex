# Cortex v3: Business Requirements Document

Version: 1.0 (June 2026)
Status: Draft for review by Amit and Sanjeev
Suggested repo location: Cortex repo, docs/spec/v3/brd.md
Companions: architecture-spec.md, reconciliation.md, plan.md (same folder)

## 1. Purpose

This BRD defines what Sevyn8 is building and why, independent of how. It is the business contract behind the Cortex v3 architecture. Where the architecture document answers "what is the system", this document answers "what must the business be able to do, for whom, and how do we know it worked".

## 2. Vision

Sevyn8 operates one intelligence platform, Cortex, and sells many vertical products on it. Cortex turns messy multi-source business data (structured records, documents, call recordings, images, video, edge sensor feeds) into trusted canonical facts, turns facts into judgments (scores, priorities, predictions, agent proposals), turns judgments into governed actions, and proves the commercial value of those actions with measurement a CFO cannot dispute.

Three Sevyn8 products already exist and form the platform's foundation: Customer Master (identity, RBAC, tenant isolation, customer SSOT), DIS (multi-tenant data ingestion, canonical mapping, quarantine, eventing, canonical store), and edge Cortex (on-device vision intelligence: Jetson and Hailo deployments). Ithina, The Body Shop / Quest Retail, and Display Data are clients and tenants of these products, not owners of them.

## 3. Market and product strategy

One engine, vertical-branded products. Buyers purchase their problem solved in their vocabulary; investors and CTOs get the platform story. The pattern is already set by StylePrint Intelligence (fashion) and FrameIQ Intelligence (eyewear).

Product portfolio and pipeline:

1. Retail intelligence (live): TBS / Quest Retail POC in flight, 25-store production decision pending. GTM pipeline: Forest Essentials, FabIndia, Titan Eye+, Nexus Select Trust, Brookfield India.
2. Insurance distribution CAC product (next, name to be chosen): broker / corporate agent client, paid-digital heavy, bleeding on junk leads, funnel drop-off, and high CPC. Engagement shape: Sevyn8 builds and licenses; paid POC then per-unit subscription with a 24-month floor, mirroring the TBS commercial structure.
3. Automotive (vertical three, warm prospect): dealer lead and service-retention pattern; a dealer selling motor insurance is the designed dual-vertical stress test.
4. Edge-fed verticals (existing): Display Data shelf and planogram intelligence; retail footfall and conversion intelligence.

## 4. Personas

1. Growth / business head (client): owns CAC, conversion, revenue; consumes dashboards, QBRs, and the value ledger.
2. Telecalling / operations manager (client): the daily-active user; consumes queues, lead routing, SLA views, call QA.
3. Data operations user (client): connects sources, reviews mappings, manages quarantine and merges.
4. Compliance officer (client): consent, audit, DSAR; a BFSI sales requirement.
5. Branch / store manager (client): consumes pushed digests and alerts; will never open a dashboard.
6. Sevyn8 operator (internal): runs many tenants from one ops console; cost, health, incidents.
7. Sevyn8 pack curator (internal): evolves vertical packs from the mapping corpus through the induction workbench.

## 5. Business requirements

Requirements are grouped by capability. Each is testable. Phasing lives in plan.md; module mapping lives in reconciliation.md.

### BR-1 Data foundation

1.1 A client can connect any reasonable source (CSV upload, SFTP drop, API pull, webhook push, streaming, media upload) through one guided front door without engineering involvement.
1.2 All ingested data is translated to a canonical, vertical-specific schema; invalid, duplicate, and junk records are quarantined and visible, and quarantine is sellable as junk-lead suppression.
1.3 Customer identity is resolved across sources (exact and probabilistic), with human review of uncertain merges; Customer Master remains the identity authority.
1.4 Raw ingested data is retained and history is replayable: when a pack or mapping improves, past data can be re-derived. Facts carry lineage to file, row, and source.
1.5 Media (call recordings first, then images, then video) is converted into canonical facts; raw media never enters the canonical store and honors retention and erasure obligations.

### BR-2 Vertical scalability

2.1 Adding a new industry vertical requires authoring a pack (schema, rules, KPIs, dashboards, terminology, extraction rules, scoring rules, playbooks, demo data), never engine code. Target: each successive vertical onboards measurably faster than the last.
2.2 Adding a client in an existing vertical requires configuration only (tenant, pack binding, sources, theme).
2.3 Every completed onboarding enriches a mapping corpus that makes the next onboarding cheaper; corpus collection is anonymized and contractually covered.
2.4 One tenant can bind multiple packs (the dealer plus motor insurance case).

### BR-3 Intelligence

3.1 Leads and other entities are scored, first by transparent vertical rules, later by ML models trained on accumulated outcomes; every judgment carries confidence, and low-confidence judgments route to humans rather than acting.
3.2 Hot leads are scored and routed in under 60 seconds from arrival.
3.3 Every score is explainable in the product (which rule, which model version, which factors) in under two minutes without engineering.
3.4 Agents can be introduced to automate review and outreach work, internal-facing first, always under named machine identities, approval thresholds, and kill switches.
3.5 Every human decision in the product (quarantine release, merge approval, disposition, agent approval) is captured as labeled ground truth.

### BR-4 Action

4.1 Issued outcomes (policies, sales) are pushed back to ad platforms as offline conversions so bidding optimizes on real outcomes; zero duplicate sends.
4.2 Drop-off recovery journeys (WhatsApp under DLT) and scored lead routing into client CRMs operate under frequency caps, consent, DND, and regulatory windows.
4.3 Every outbound action is recorded with full state (proposed, approved, executed, confirmed, failed), is idempotent, is auditable, and can be stopped by a kill switch.
4.4 Personas who never open dashboards receive pushed digests and threshold alerts.

### BR-5 Proof of value

5.1 Baseline metrics (for insurance: CAC by channel) are captured at onboarding and agreed with the client in writing.
5.2 Value is measured against a counterfactual (holdout groups), not assertion; the platform never quotes a non-holdout delta.
5.3 A monthly value statement (auto-QBR) is generated per tenant: value realized, pipeline health, recommendations.
5.4 Metering is contract-grade, enabling future outcome-based pricing (per qualified lead, percent of CAC saved).
5.5 Time-to-first-value is instrumented per tenant (connect, first canonical rows, first insight, first routed lead) with targets.

### BR-6 Trust and compliance

6.1 Tenant isolation is provable (RLS for standard tenants; a dedicated-instance tier is available for enterprise buyers).
6.2 DPDP obligations are met as product features: consent ledger, purpose registry, retention clocks, DSAR handling, erasure that reaches media blobs.
6.3 IRDAI outreach constraints and TRAI DLT requirements are enforced by the platform, not by client diligence.
6.4 A BFSI-grade security review package exists and passes a dry run: isolation posture, consent architecture, audit trail, and the model-use policy (self-hosted inference in the data plane; generative LLM calls on tenant data require tenant opt-in and stay in asia-south1).
6.5 Source schema drift and model decay are detected and alerted before they corrupt results; clients can see their own pipeline health.

### BR-7 Operations and unit economics

7.1 Sevyn8 can operate ten or more tenants with two engineers: cross-tenant ops console, incident visibility, cost per tenant.
7.2 Cost-to-serve is measured per tenant, per event, per inference (ASR minutes, GPU seconds, ad-API calls) so pricing protects margin.
7.3 Edge deployments (Cortex edge) feed the platform as premium sources and are managed (device fleet, buffering, sync) without becoming a second platform.

## 6. Success metrics

1. Insurance client: baseline CAC captured by POC week 4; measured holdout-backed CAC reduction at production decision; defensible verbal target range 25 to 35 percent, never written before baseline.
2. Flywheel: automotive onboarding faster than insurance onboarding on TTFV days and auto-suggest acceptance rate, quantified.
3. Engine purity: zero engine commits attributable to vertical-specific functionality, audited at every gate.
4. Operations: two engineers operate all tenants; cost-to-serve per tenant visible and trending down.
5. Commercial: TBS production conversion; insurance POC to subscription conversion; one new retail logo from the GTM list within two quarters of demo-tenant availability.

## 7. Constraints

1. Team: two full-stack engineers (Amit, Sanjeev) plus Claude Code leverage; WIP limit of two active phases.
2. Region: asia-south1 primary; asia-south2 for DR posture.
3. Live systems: DIS and Customer Master are near-live, enterprise grade, and are the foundation; they are extended, never rebuilt.
4. Regulatory: DPDP, IRDAI, TRAI DLT as above.
5. Repo discipline as established (plan-mode, conventional commits, no AI co-author trailers, spec-or-code drift rule, no em-dashes in repo files).

## 8. Out of scope (explicitly, for now)

On-prem deployment; pack marketplace with third-party publishers; cross-tenant benchmarking; knowledge graph; federated learning; prescriptive budget optimization before measurement credibility; customer-facing agents before internal agents prove guardrails.

## 9. Top business risks

1. Machine auth and identity boundary decisions stall (blocks conversion loop and media): mitigated by making them the first joint work items.
2. Client finance disputes value claims: mitigated by holdouts from day one.
3. Vertical creep converts the company into per-client codebases: mitigated by the zero-engine-commits gate test.
4. Media costs erode margin: mitigated by per-minute cost telemetry before the media tier is priced.
5. Two-person overload: mitigated by the WIP limit and the stub-don't-wait contract discipline.

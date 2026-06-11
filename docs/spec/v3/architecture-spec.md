# Cortex v3: Architecture and Specification

Version: 3.0-draft (June 2026)
Status: Supersedes the platform source-of-truth v2.1 and re-baselines spec v2.2.
Suggested repo location: Cortex repo, docs/spec/v3/architecture-spec.md
Companions: brd.md, reconciliation.md, plan.md. Diagram: sevyn8-platform-architecture-v4 (to be re-titled Cortex v3).

## 1. What Cortex v3 is

Cortex v3 is the umbrella specification for Sevyn8's intelligence platform. It re-baselines spec v2.2 on two facts that overtook it: DIS and Customer Master are live, enterprise-grade Sevyn8 products, and they are the platform's data and identity planes respectively. v2.2's module catalog remains the intellectual inventory; v3 assigns every module a disposition against the live estate (see reconciliation.md) instead of specifying parallel rebuilds.

Governing correction (ADR-SCOPE-010, drafted in reconciliation.md): v2.2 section 4.1a characterized DIS as an external partner platform ("Ithina's ROOS") to be consumed but never subsumed. That characterization is outdated. DIS is a Sevyn8 product; Ithina is a tenant. The consume-only boundary is replaced by: DIS is Cortex v3's data plane.

## 2. Plane model

Seven planes. Module IDs in parentheses refer to spec v2.2 and are the requirement inventory for each plane; dispositions per module are in reconciliation.md.

### 2.1 Identity plane: Customer Master [LIVE]

Auth0 OIDC and SSO for users, machines, and (future) agents; RBAC SSOT with the fixed scope hierarchy and the Superadmin 4-tuple (Module, Resource, Action with VIEW / CONFIGURE / EXECUTE / APPROVE / OVERRIDE / AUDIT, Scope); tenant and store resolution via identity_mirror; customer SSOT.
v2.2 mapping: Customer Master is the implementation of AC01 (ABAC + RBAC) and AC02 (Hierarchy Engine); gaps in those modules' FRs become CM backlog, not new services (ADR-IDENTITY-001). AC03 (Consent and Privacy Manager) is adopted into CM as the consent ledger. Vertical display vocabulary (Store vs Branch vs Dealership) comes from pack i18n labels; scopes never change (pairs with IC02).
Rule: nothing in the platform re-validates what Customer Master asserts.

### 2.2 Data plane: DIS [LIVE core, extensions specified]

One product, one API, one front door (Connect-a-System; v2.2 G01's five ingestion modes are the requirement set: file, API push, webhook, scheduled pull, streaming). Live today: CSV and SFTP and pull-worker ingestion, pack-driven canonical mapping with date tokens, quarantine, Pub/Sub spine with versioned schemas, Postgres canonical store with RLS, recharts dashboards in flight.
Extensions specified by v3:

1. Streaming fast path: webhook lead to scored-and-routed in under 60 seconds (G01 streaming mode plus S01 essentials).
2. Media pipeline: signed GCS upload URLs, telephony SFTP and webhooks, extraction workers (ASR with diarization, OCR and vision on ONNX, frame sampling) emitting derived canonical facts only; blobs stay in GCS under lifecycle, retention class, and DPDP erasure reach (G03 documents, G04 video, G05 audio are the requirement inventory; audio first).
3. Entity resolution stage: normalization, probabilistic matching with confidence, auto-merge above threshold, human review below (I01 SIR is the requirement set; I03 supplies survivorship rules). Proposes merges; CM adjudicates identity.
4. Temporal and replay foundation: bi-temporal columns and discipline ported from the Cortex repo's F03 work (SQL migrations and the bi-temporal lint script are the first code salvage), plus a bronze raw-retention layer and replay so canonical history can be re-derived on pack upgrades, plus lineage to file, row, and source (D05 requirement set).
5. Quality and contracts: D04 quality scoring and profiling extends quarantine; D03 data contracts formalize source expectations.
   Runtime discipline: structured and media pipelines are separate deployables with separate fleets, SLOs, and cost lines; a media burst must never degrade lead-ingestion latency, proven by load test.

### 2.3 Vocabulary plane: Atlas [SPECIFIED, merges IC01 + D01 + F04 + F05]

Atlas is the market name; IC01 is the module lineage. A pack is the complete versioned definition of a vertical, structured on D01's three-tier ontology (Tier 1 core ontology owned by the engine; Tier 2 vertical extension owned by the pack; Tier 3 tenant configuration): canonical schema with PII classification, validation and quarantine rules, KPI and metric definitions (D01 gold layer), dashboard templates, UI manifest and terminology (IC02), media extraction rules, scoring rules, agent playbooks, reference and demo data, industry benchmarks for cold start.
Distribution mechanics (new in v3): packs are signed (cosign), SemVer'd, declare engine-compatibility ranges, distributed as artifacts; tenants pin versions; upgrades are explicit and replayable. Configuration resolution (F04) and schema evolution (F05) are absorbed as pack versioning plus the engine-defaults / pack / tenant resolution order.
The mapping corpus (anonymized header and mapping patterns per vertical, pgvector) powers auto-suggest and feeds the induction workbench (profiler, Gemini-assisted induction, human curation; control plane only; MSA learnings clause required). Corpus and pack stay distinct with a human gate between them.
Registry v0: signed artifacts in GCS plus a loader in DIS; graduates to a standalone service when a second runtime (edge Cortex) consumes packs.

### 2.4 Intelligence plane [SPECIFIED, merges A02 / A03 / A04 / A06 / FB01 with v3 designs]

Facts in, judgments out: subscribes to the spine, computes, publishes judgments back to the spine as canonical events (lead.scored, action.proposed). Judgments are facts: stored canonically, charted by analytics, routed on by interaction, traceable to rule or model version.
Components: rules evaluator executing pack-shipped declarative rules (A06; CEL or JSON Logic); model registry and serving (A02 plus A04: signed, versioned, engine-compat-declared models, ONNX self-hosted, per-tenant training by default, pooled only under explicit consent); eval harness (golden sets per vertical, offline regression gating every rule, model, and playbook version, champion and challenger in production; A04 plus SCR-13 inventory); confidence and abstention (every judgment carries confidence; below threshold the system routes to a human queue, FB01's human-in-the-loop pattern); agents (pack playbooks, CM machine identities, EXECUTE within scope, APPROVE for high impact, OVERRIDE human-only) which reason here and act only through the interaction plane.
A05 LLM Gateway is adopted as the single choke point implementing the model-use invariant: control-plane generative use freely; tenant-data generative use only with tenant opt-in, in-region.

### 2.5 Analytics plane [LIVE base, extensions specified]

Semantic metric layer holding pack-defined KPI definitions; dashboards (recharts redesign in flight; CX-01 through CX-10 are recast as Retail pack dashboard templates, not engine screens); drift and health monitoring with a client-visible health page (D04 plus FB03 inventory); the measurement module: holdout experimentation, value ledger (baseline, counterfactual, realized value; contract-grade metering with OB03), TTFV instrumentation, auto-QBR (FB02 decision-outcome linkage is the closest v2.2 ancestor; holdout counterfactuals are new in v3). CX-05 Ask Cortex becomes the natural-language surface compiled to governed semantic-layer queries, RLS-scoped, later phase. This plane reads; it never writes back.

### 2.6 Interaction plane [NEW in v3; SCR-17, O01, O02, AC04 are the nearest v2.2 ancestors]

The only place actions happen. Offline conversions push (Google Enhanced Conversions, Meta CAPI); journeys and routing (WhatsApp under DLT, scored lead routing, webhooks and SSE); notification fabric (O02: persona digests and threshold alerts, content from the semantic layer). Every outbound action passes a policy gate (frequency caps, DND and DLT, consent via AC03, IRDAI windows, per-agent budgets, kill switches; AC04 compliance-as-code supplies the rule format) and is recorded in an action ledger with full semantics: proposed, approved, executed, confirmed, failed; idempotency keys; retries; compensation. Connectors are certified (sandbox, dry run, rate limits) before production. The audit trail behind the 4-tuple's AUDIT action lives here (SCR-20).

### 2.7 Experience plane [LIVE shell, layering specified; UX01 and W01 ancestry]

Resolution stack: engine defaults, then pack, then tenant (UX01's screen composition intent, made concrete). Six engine archetypes: list, detail, wizard, dashboard, funnel, and the work queue (claim, decide, audit; serves quarantine triage SCR-10, merge review SCR-11, agent approvals, label capture; every decision is ground truth). Pack layer: UI manifest, terminology as i18n, dashboard templates. Tenant layer: theme tokens, flags, label overrides; never schema or rules. Widget registry: the CI-gated escape hatch for bespoke components. Persona surfaces: growth, telecalling manager, data ops, compliance officer (SCR-16, SCR-22), and the Sevyn8 ops console (SCR-24, SCR-21). The SCR catalog maps to archetype-driven screens with owners per the swimlane plan; W01 tenant onboarding extends Connect-a-System.

### 2.8 Edge: Cortex sensing products [LIVE, narrowed scope]

ED01 orchestrator and ED02 buffer-and-sync remain Cortex-repo-native: device fleet management (SCR-15), on-device vision (Jetson, Hailo, TensorRT, YOLO, ArcFace), buffering and sync. In v3, edge deployments are premium sources feeding DIS's front door with canonical facts (footfall, dwell, shelf state), using exactly the external-source consumption pattern v2.2 designed, pointed inward. CX-DD-01 (Display Data shelf intelligence) becomes a vertical pack over edge-fed facts. ED03 federated learning is deferred.

## 3. Contracts (the inter-service interface)

Held in the sevyn8/contracts repo as language-neutral artifacts (JSON Schema, OpenAPI):

1. Machine-auth token contract (claims, scopes, validation). Frozen first; consumers: ingestion, media, ad push, agents.
2. Spine event schemas, versioned per event type.
3. Action ledger API (propose, query state); permissive stub until the real gate lands.
4. Merge semantics API (resolution proposes, CM adjudicates).
5. Consent query API.
6. Pack contract (structure, SemVer rules, engine-compat declaration, signing).
   Changes only at gate boundaries; mid-phase needs are logged and stubbed around.

## 4. Repository and runtime topology

Repos: Cortex (TS monorepo: new platform services in Amit's swimlane, namely Atlas registry and workbench, intelligence services, measurement services; shared TS packages @cortex/observability and @cortex/event-bus; edge modules; tag v2-final before re-scoping), DIS (Python data plane plus dis-ui React), CM (Sanjeev's swimlane: identity, consent, policy gate, action ledger, certified connectors, compliance surfaces), contracts (tiny, language-neutral). No repo merge; CODEOWNERS per repo enforces swimlanes.
Runtime: GCP asia-south1 (asia-south2 DR posture per RE01); Cloud Run services; GCE VMs for SFTPGo and heavy extraction; Pub/Sub spine; Postgres with pgvector, RLS, and bi-temporal discipline; GCS blobs and bronze; BigQuery gold; Terraform; Artifact Registry plus cosign for packs and models.

## 5. Invariants (design-review checklist)

1. Packs are data; pack-referenced code lives only in versioned registries (widgets, models, playbooks).
2. New vertical: new pack, zero engine commits. New client: configuration only.
3. Customer Master is the sole identity authority (AC01 and AC02 are CM; ADR-IDENTITY-001).
4. The canonical store holds facts only; blobs never enter it; raw is retained in bronze; history is replayable; facts carry lineage.
5. Hierarchy scopes are fixed; verticals vary display labels via pack terminology.
6. Tenants may override theme, flags, labels; never schema or rules.
7. Corpus entries are anonymized patterns, never values; a human gate sits between corpus and pack.
8. All generative LLM access goes through the A05 gateway: self-hosted deterministic inference is free in the data plane; generative calls on tenant data require tenant opt-in and stay in asia-south1.
9. Media processing never degrades lead ingestion; proven by load test.
10. Judgments are facts with confidence; low confidence abstains to a human queue.
11. Agents reason in the intelligence plane and act only through the interaction plane, under CM machine identities, policy-gated, idempotent, audited.
12. Product boundaries follow the user's mental model; runtime boundaries follow physics.
13. Spec drift rule (from CLAUDE.md, elevated to platform law): update the spec or update the code, never leave drift uncommented; significant divergence gets an ADR.

## 6. Open architecture decisions

1. ADR-SCOPE-010 ratification (DIS is the data plane; supersedes 4.1a / ADR-SCOPE-009). Drafted in reconciliation.md.
2. ADR-IDENTITY-001 ratification (CM implements AC01 / AC02 / AC03; FR gap list becomes CM backlog). Drafted in reconciliation.md; Sanjeev decides.
3. Machine-auth token design (contract 1). Sanjeev.
4. F03 bi-temporal porting depth into the DIS store (full bi-temporal everywhere vs bi-temporal on designated tables plus bronze replay). Amit, during Phase R salvage audit.
5. Where the dashboards' gold layer lives long term (Postgres materializations vs BigQuery) given D06's mapping. Defer until dashboard volume forces it.

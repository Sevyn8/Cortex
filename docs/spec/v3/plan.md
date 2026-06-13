# Cortex v3: Plan

Version: 1.0 (June 2026)
Status: Working plan for a two-engineer build (Amit, Sanjeev) with Claude Code leverage.
Suggested repo location: Cortex repo, docs/spec/v3/plan.md
Companions: brd.md, architecture-spec.md, reconciliation.md. Detailed gate criteria carry over from the platform source-of-truth v2.1 Section 9 and are summarized here.

## 1. Operating model

Two full-stack engineers, split by service ownership, never by frontend/backend layer. Each owns complete slices (backend, API, UI) within a swimlane. The spine plus six frozen contracts (architecture-spec section 3) is the entire interface between swimlanes. Stub-don't-wait is the default. WIP limit: two active phases (one primary, one parallel). One mandatory 30-minute weekly contract review; everything else async via repos and plan reviews.

Swimlanes:

1. Sanjeev (trust): Customer Master core; machine and agent identity; consent ledger (AC03); policy gate (AC04 rules); action ledger; connector certification and the ad-platform push connectors; compliance and audit surfaces (SCR-16, SCR-17, SCR-20, SCR-22, SCR-23); DLT registration; the PR privacy suite in its phase.
2. Amit (value): DIS engine (pipelines, fast path, entity resolution, spine, bronze and replay, lineage); Atlas (pack contract, registry, corpus, workbench, packs); intelligence plane (rules, models, eval, agents runtime); analytics and measurement; media pipeline; experience engine (archetypes including the work queue, pack manifest resolution, onboarding, dashboards, queues); edge Cortex continuity.

Repos (logical name equals actual repo): Cortex equals `Cortex` (this repo; Amit's new TS platform services, salvaged packages, edge; tagged v2-final first); DIS equals `ithina-retail-dis` (Amit); CM equals `ithina-retail-admin-backend` plus its companions `ithina-retail-admin-infra` and `admin-frontend` (Sanjeev); contracts equals a repo not yet created, stood up in Phase R (shared, language-neutral). CODEOWNERS per repo enforces the swimlanes. Repo-naming reconciliation and the full actual-to-logical map are tracked in reconciliation.md section 7.

Infrastructure model: three layers (foundation, then per-product services, then cross-product contracts), applied in the order foundation, CM, DIS, platform services (see docs/runbooks/deploy-order.md). The cross-product topology is an open decision in ADR-INFRA-008 (Proposed): one common platform project, or keep the three isolated projects plus a thin shared-services project for the spine, or keep three projects with the spine in DIS; the choice is joint with Sanjeev at GR and weighs isolation against convenience ahead of the BFSI review. Regardless of option, repos stay separate with CODEOWNERS and cross-stack consumption is by name, never terraform_remote_state. Today the three products are separate per-product projects (see docs/architecture/infra-shared-resource-register.md).

UI collision rule: Amit owns onboarding, dashboards, and queue screens; Sanjeev owns admin, compliance, and audit screens; shared components only via the archetype library.

## 2. Phase plan

### Phase R: Reconciliation (1 to 2 weeks, starts now, overlaps Phase 0)

Owner: Amit primary; one joint session with Sanjeev.
Scope: ratify the Module Disposition Register (reconciliation.md section 2, resolving every [verify] flag against full FR text and repo code in Claude Code on TINA-HOME); ratify ADR-SCOPE-010 and ADR-IDENTITY-001; tag Cortex repo v2-final; run the salvage audit; create the contracts repo with the pack contract draft; assemble the v3.0 spec from these documents.
Gate GR (joint): both ADRs ratified; register complete with no unresolved [verify] flags on Phase 1 and 2 dependencies; salvage tiers assigned; contracts repo exists.

### Phase 0: Hygiene and unblocking (1 to 2 weeks, parallel with R)

Sanjeev: machine-auth token contract designed and frozen (contract 1; covers ingestion, media, ad push, agents in one design); AC01 / AC02 / AC03 FR gap list against CM; labels approach ratified inside ADR-IDENTITY-001; standing DeadlineExceeded and quarantine-cache items cleared.
Amit: dis-gemini IAM binding; push 7af93dc; insurance product name chosen; MSA learnings clause to legal.
Gate G0 (joint): token contract frozen; ADRs ratified (shared with GR); name chosen.

### Phase 1: Atlas seed and replay foundation (3 weeks)

Amit: pack contract finalized; Retail pack v0.1 extracted from DIS code (extraction, not authorship, proves packs); registry v0 (signed GCS artifacts plus DIS loader); bronze retention and replay; lineage capture; F03 bi-temporal port begins on designated store tables; cost-telemetry skeleton; TTFV instrumentation.
Sanjeev: machine-auth issuer built in CM; consent ledger v1; policy-gate design (consumes AC04 rule format).
Gate G1 (owner Amit): DIS boots with the retail pack from the registry, zero regression; a replayed ingestion reproduces canonical rows identically; pack version swap needs zero engine commits; raw retained for all new ingestion. This gate never slips for demos.

### Phase 2: Insurance pack and lead data product (6 weeks)

Amit: insurance canonical schema through the half-manual workbench with the client's real files; lead sources plus one insurer MIS feed onboarded; quarantine tuned as junk suppression; entity resolution v1 (I01) with the merge-review queue; work-queue archetype lands (sixth archetype; sanctioned engine work); semantic layer v1 and baseline CAC dashboards; ground-truth events from day one; pack-seeded demo tenant.
Sanjeev: policy gate and action ledger build (backend plus admin UI) behind contract 3 with a permissive stub published immediately; connector certification harness; compliance-officer view v1; consent capture wired into onboarding; DLT registration in flight.
Gate G2 (owner Amit; client-facing criteria agreed in writing): zero engine commits for insurance functionality beyond the sanctioned archetype; baseline CAC published and client-acknowledged; junk suppression measured; resolution precision spot-checked; TTFV captured as the corpus benchmark.

### Phase 3: Intelligence v1 and the conversion loop (5 weeks)

Amit: rules evaluator (A06 FRs) on the spine; lead.scored facts; streaming fast path with the under-60-second SLO; routing webhooks; holdout configured; value ledger recording against the G2 baseline; telecaller disposition capture.
Sanjeev: offline-conversion connectors (Google Enhanced Conversions, Meta CAPI) live on the real action ledger and policy gate; certification (sandbox, dry run, rate limits) enforced; caps, DND and DLT, consent enforcement on.
Gate G3 (joint; finance-grade): conversions flowing to both platforms with zero duplicate sends over a two-week window; fast-path SLO met at p95; holdout untouched; first measured CAC delta from the value ledger with the holdout as counterfactual. If inconclusive at four weeks, extend observation; never quote a non-holdout number.

### Phase 4: Media pipeline MVP (6 weeks, parallel track; may start after G1)

Amit: media ingestion endpoints under the Phase 0 token contract; GCS lifecycle, retention classes (PR06 early), DPDP erasure end to end; ASR with diarization (G05 FRs); intent and objection facts feeding Phase 3 scoring; media metadata plus embeddings; per-tenant media cost telemetry; QA label capture in the work queue.
Sanjeev: erasure and consent integration review; retention clock service if not landed in his Phase 2 tail.
Gate G4 (owner Amit): offline backtest shows call facts improve scoring discrimination; load test proves lead-ingestion latency unaffected; erasure verified into GCS; media cost visible per tenant.

### Phase 5: Trust and scale (5 weeks, overlapping Phase 4 tail)

Amit: lineage-backed explainability in UI (A07; why-this-score under two minutes); drift and health monitoring with the client-visible page; eval harness v1 plus abstention (gates the first ML model); notification fabric (O02) and auto-QBR v1; ops console v1 (SCR-24, SCR-21).
Sanjeev: PR01 purpose registry, PR02 DSAR pipeline and console, PR03 breach pipeline; the BFSI security package (isolation, consent, audit, model-use policy) assembled jointly and dry-run.
Gate G5 (joint): a scoring question answered from the UI without engineering; simulated schema drift alerts before quarantine floods; first auto-QBR used in a real client conversation; security package passes a BFSI checklist dry run.

### Phase 6: Second vertical, first ML, first agent (timed to the automotive opportunity; nominal Q4 2026 to Q1 2027)

Amit: automotive pack through the now-real workbench; automotive tenant onboarded; dual-pack tenant (dealer plus motor insurance) tested; first ML model via the model registry (A02 plus A04), gated by the eval harness, champion-challenger against rules; first internal agent (quarantine triage or telecalling QA, chosen at G5 on queue volumes) in the intelligence runtime.
Sanjeev: agent machine identity, APPROVE thresholds, kill-switch authority (joint design); ops maturation across three-plus tenants.
Gate G6 (joint): automotive onboarding zero engine commits and measurably faster than insurance (TTFV days, auto-suggest acceptance, versus the G2 benchmark: the quantified flywheel); ML challenger beats rules on golden set and production calibration before promotion; one hundred percent of agent actions traverse gate and ledger; abstention verified.

### Phase 7: Category platform (2027, continuous)

Sequenced by readiness: NL surface (CX-05 plus E02) on the semantic layer; customer-facing agents after internal guardrail maturity; prescriptive optimization (A08) after measurement credibility; registry as a standalone service when edge Cortex consumes packs; OB03 billing when outcome pricing is real; images then video maturity (G03, G04); cross-tenant benchmarking under consent; DX01 SDK on demand. Rolling quarterly review against invariants and unit economics.

## 3. Running threads

Ground-truth capture, corpus enrichment, cost telemetry, security posture, conformance tests from salvaged FRs, and repo discipline (plan-mode for dis-ui, conventional commits with module scopes, spec-or-code drift rule, no AI co-author trailers, no em-dashes, operator-authorized pushes, workflow SKILL.md first) run through every phase and are never "done".

## 4. Market triggers and re-sequencing rules

1. Automotive accelerates: pull pack authoring into the Phase 4 / 5 window; never before G1; the dual-pack test stays.
2. Insurance stalls: Phase 1 continues regardless; Phase 2 pivots to retail corpus enrichment and demo tenants for the Forest Essentials and FabIndia conversations.
3. TBS converts to 25 stores: pull ops console and cost telemetry forward; production operations outrank features.
4. BFSI enterprise prospect: Phase 5 compliance items gate the close; reprioritize inside the WIP limit, never add a third active phase.
5. Any client request implying an engine commit for vertical functionality is reshaped as pack, config, or registered artifact, or declined; deadline pressure is not an exception.

## 5. Two-person risk controls

1. Bus factor: every service has a README-runbook; the weekly contract review doubles as cross-knowledge transfer; Claude Code session notes committed with WIP discipline.
2. Overload: the WIP limit is enforced at gate reviews; a swimlane blocked on the other for more than two days is a cadence failure fixed in the weekly, never by cross-committing.
3. Decision latency: gates are joint, but each has a named owner who decides on a split vote (per the source-of-truth Section 9 criteria).
4. Scope gravity: the disposition register is the shield; anything not ADOPT, MERGE, or NEW-IN-V3 for the current phase is parked with its named trigger.

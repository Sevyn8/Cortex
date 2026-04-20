# ADR-SCOPE-009: ROOS Remains External to Cortex

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2 Spec §G01, §CX-DD-01; Ithina DIS (ROOS) Architecture v13 (April 2026)

---

## Context

Ithina operates a production data ingestion platform called ROOS (DIS v13) — a multi-tenant Kafka-based event pipeline that ingests retail events from POS systems (Square, Clover, Lightspeed, future providers), enriches fat/skinny payloads, persists to a Bronze tier, transforms to a canonical Gold tier, and exposes events on `dis.golden.roos` for downstream consumers. Ithina's existing agents (PA, PAC, PROMO, POG) run on ROOS.

Cortex, as specified in the v2 Complete System Specification, includes its own ingestion layer (G01 Universal Ingestion Gateway, G02 Structured Data Pipeline) and its own suite of agents for Display Data (Planogram, PAC, Promotion, Perishable, to be built in Phase 1).

This creates an obvious question: **do Cortex and ROOS compete, merge, or integrate?** There are three viable paths:

- **Path A:** Cortex consumes from ROOS. Ithina continues operating ROOS; Cortex is a downstream consumer.
- **Path B:** Cortex absorbs ROOS. Sevyn8 takes over POS ingestion; Ithina retires ROOS over time.
- **Path C:** Hybrid. ROOS handles existing POS ingestion; Cortex handles the canonical layer and all new intelligence; boundary evolves.

Each has materially different engineering scope, operational implications, commercial implications, and Phase 1 risk profile.

## Decision

**Path A. ROOS remains external to Cortex. Cortex consumes from ROOS as an upstream data source.**

Specifically:

1. **ROOS ownership and operations stay with Ithina.** Ithina continues to own ROOS's infrastructure (Kafka cluster, listener services, Redis, Bronze storage), its operational SLA, scaling, and maintenance.

2. **ROOS's existing agents stay on ROOS.** PA, PAC, PROMO, POG continue running where they currently run. Cortex does not replace or duplicate them.

3. **Cortex consumes the canonical output.** The integration boundary is `dis.golden.roos` — the canonical Gold-layer topic that ROOS publishes. Cortex has no visibility into or dependency on ROOS's internal topics (`dis.ingest.*`).

4. **Cortex agents are complementary, not overlapping.** Cortex's Phase 1 agents (Planogram, PAC, Promotion, Perishable) operate primarily on data types ROOS does not process today — shelf imagery (from the Ithina HHT app, ingested directly via Cortex's webhook connector, NOT via ROOS), inventory signals, and canonical retail events from ROOS combined with computer-vision outputs. Where nomenclature overlaps (ROOS PAC vs Cortex PAC), boundaries are documented in `/docs/integrations/roos-agent-boundaries.md`.

5. **Sevyn8 does not build POS-specific connectors.** No Cortex code exists for Square, Clover, Lightspeed, or any other POS-specific ingestion. All retail-transaction data reaches Cortex exclusively via the ROOS connector.

6. **Cortex's HHT / shelf imagery path is direct.** Ithina's HHT app uploads shelf imagery via HTTPS webhook to Cortex's G01 webhook endpoint, bypassing ROOS entirely. This is a new data type ROOS does not handle, and Cortex owns it end-to-end.

## Rationale

### Why Path A over Path B (absorb ROOS)

**Engineering cost.** Path B requires Cortex G01 to grow significantly: fat/skinny enrichment patterns, per-POS listener templates, 500ms webhook ACK budget, dedicated Redis for dedup/auth caching. Estimated Phase 1 scope expansion: +25–30%. The CV + LLM intelligence work that differentiates Cortex (shelf imagery, planogram compliance, perishable markdown recommendations) gets pushed out by equivalent months.

**Operational cost.** Sevyn8 takes on 24/7 operational responsibility for ingestion across every Ithina downstream retail client. For a pre-revenue two-person team, this is a risk, not an asset.

**Migration risk.** ROOS has production tenants processing real retail events. Migrating them to a newly-built Cortex ingestion layer is a months-long project where any downtime is a commercial incident. No forcing function justifies taking that risk in Phase 1.

**Zero product benefit in Phase 1.** Display Data's clients don't care whether their data lands in ROOS or Cortex first — they care about the intelligence outputs (findings, recommendations, dashboards). Those all sit in Cortex in either path. Path B does more work for the same user outcome.

### Why Path A over Path C (hybrid, evolving boundary)

Path C is mostly a weaker version of Path A. A boundary that "evolves" is a boundary nobody defends, which becomes a boundary that leaks. Cortex ends up subtly taking on ROOS responsibilities over time without ever making the decision explicitly. Better to draw a clean line and require a new ADR if it ever needs to move.

### Why Path A is the right answer

- **Scope discipline.** Phase 1 stays focused on Display Data's differentiator: CV-based retail intelligence and agent-driven compliance findings. Not on re-implementing POS ingestion Ithina already does well.
- **Leverages existing production value.** ROOS works. Don't rebuild what works.
- **Clean interface.** `dis.golden.roos` is a single well-defined contract. Easier to reason about than "somewhere in the murky middle."
- **Commercially clean.** Each side owns its part. Ithina owns ROOS relationships with POS providers; Sevyn8 owns Cortex relationships with end-retail clients for intelligence outputs. No confusion about who operates what.
- **Portable.** If a future Sevyn8 client wants Cortex without ROOS (a non-Ithina retail engagement), Cortex still works — the ROOS connector is one of many G01 connectors, and other connectors (generic webhook, SFTP, direct POS integrations if ever needed) serve different data sources.

## Consequences

### Positive

- **Phase 1 scope is ~15% smaller than it would be under Path B.** Freed engineering time goes into CV and agent quality.
- **Integration is a well-defined contract**, not a dependency graph. One topic (`dis.golden.roos`), one connector, one interface document (`/docs/integrations/roos-interface.md`).
- **Ithina's ROOS investment is preserved**, strengthening the Sevyn8 ↔ Ithina partnership rather than threatening it.
- **Cortex's ingestion layer remains general-purpose.** The Kafka connector used for ROOS is the same connector framework used for any future Kafka source. No ROOS-special-casing leaks into G01.

### Negative

- **Operational dependency on Ithina.** If ROOS is down, Cortex's retail-transaction data stops flowing for Display Data. Mitigated by (a) explicit joint runbook for ROOS outages, (b) CX-DD-01 graceful degradation when ROOS events are stale, (c) observability on consumer lag feeding SCR-08 alerts.
- **Schema coupling.** Changes to ROOS canonical schema break Cortex. Mitigated by the D03 data-contract mechanism and schema-evolution notification clause in the integration contract.
- **Data transformation cost.** ROOS canonical ≠ Cortex canonical. D02 mapping rules must translate. This is standard data-engineering work; not a blocker.
- **Shared incident surface.** When something goes wrong on the pipeline, on-call rotations on both sides need to coordinate. Joint runbooks and a documented escalation path address this.

### Neutral

- Ithina sees Cortex traffic in their Kafka dashboards (Cortex consumer group name convention per `/docs/integrations/roos-interface.md`). This is expected and intentional — shared visibility strengthens the integration.
- The boundary between ROOS agents (PA, PAC, PROMO, POG) and Cortex agents (Planogram, PAC, Promotion, Perishable) requires ongoing clarity, especially where nomenclature collides. Addressed by `/docs/integrations/roos-agent-boundaries.md`.

## Alternatives considered

### Alternative 1: Cortex absorbs ROOS (Path B)

Rejected. Phase 1 scope expansion, operational risk, migration complexity all point the wrong direction for a pre-revenue team. Revisit only if (a) Ithina wants to stop operating ROOS, or (b) a non-Ithina retail client wants Cortex without ROOS at meaningful volume, which argues for strengthening Cortex's native POS ingestion anyway.

### Alternative 2: Cortex and ROOS merge into single platform

Rejected. Would require legal restructuring between Ithina and Sevyn8 that is out of scope for this technical decision. Also would blur commercial positioning that currently serves both sides well.

### Alternative 3: Cortex builds parallel POS ingestion for non-Ithina clients, leaving ROOS for Ithina clients

Rejected for Phase 1. This introduces two ingestion paths with similar shape but different implementations, which is the worst of both worlds. If Cortex ever needs native POS ingestion (e.g., for a Body Shop direct integration), that's a deliberate future decision via a new ADR — not something we build speculatively now.

### Alternative 4: Cortex runs a thin mirror of ROOS for disaster recovery

Rejected. DR is RE01's responsibility and should use Pub/Sub + BigQuery archives, not a mirror of an external dependency. If ROOS DR is a real concern, it's Ithina's DR problem (their RTO/RPO), not Cortex's.

## Boundary specification

The contract between ROOS and Cortex is codified in `/docs/integrations/roos-interface.md`. That document — owned jointly by Sevyn8 and Ithina engineering — is the governance artifact for this integration.

Any change to the boundary requires updating that document AND this ADR.

Specifically OUT of scope for Cortex:
- POS-specific listener code (Square, Clover, Lightspeed, etc.)
- Fat/skinny payload enrichment patterns
- ROOS's Redis, Bronze tier, or internal Kafka topics
- ROOS's agents (PA, PAC, PROMO, POG)
- ROOS's Kafka cluster operations
- Direct integration with POS provider APIs (unless an explicit future decision reverses this)

Specifically IN scope for Cortex (relating to ROOS):
- The ROOS Kafka connector within G01
- Schema translation from ROOS canonical to Cortex canonical (D02 mapping rules)
- Monitoring Cortex's consumer lag against ROOS
- Joint runbook ownership for integration incidents
- Operational relationship management with Ithina ops

## Coordination artifacts required before Phase 1 build

Before implementing P4.4 (G01 with ROOS connector), the following must exist:

1. `/docs/integrations/roos-interface.md` — at minimum a stub with all 10 sections listed, even if TBD. Ithina engineering counter-signs.
2. Staging access: ROOS staging endpoint, Cortex consumer credentials, test topic with sample events. Without this, P4.4 integration tests run only against simulated fixtures.
3. Agent boundary document `/docs/integrations/roos-agent-boundaries.md` — captures what ROOS PAC does vs what Cortex PAC does; same for PROMO; clarifies Cortex Planogram and Perishable are new (not overlapping).
4. Joint on-call contact list — who Sevyn8 calls when ROOS integration breaks; who Ithina calls when Cortex stops consuming.

None of these are Sevyn8-only artifacts; all require Ithina engineering participation.

## Revisit triggers

This decision should be revisited if any of the following happen:

- Ithina indicates they want Sevyn8 to take over ROOS operations
- Non-Ithina retail clients (Body Shop direct, Titan, FabIndia, etc.) engage Sevyn8 at volumes justifying native POS ingestion
- ROOS reliability or capability becomes a sustained drag on Cortex's value delivery to Display Data's downstream clients
- Ithina and Sevyn8 merge or otherwise restructure their relationship
- A major change in ROOS architecture (e.g., Ithina migrates ROOS off Kafka) changes the integration contract

## References

- Ithina DIS (ROOS) Architecture v13, April 2026 (internal document)
- Cortex v2 Complete System Specification, §G01, §CX-DD-01
- `ADR-INFRA-001-event-bus-choice.md` — companion decision on Pub/Sub internal + Kafka at edges
- `/docs/integrations/roos-interface.md` — the integration contract (to be created)
- `/docs/integrations/roos-agent-boundaries.md` — agent responsibility boundaries (to be created)

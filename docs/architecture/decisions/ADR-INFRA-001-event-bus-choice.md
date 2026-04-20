# ADR-INFRA-001: Event Bus Choice — Pub/Sub Internal, Kafka at Integration Edges

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2 Spec §F01, §G01, §S01; Ithina DIS (ROOS) architecture v13

---

## Context

Cortex needs an event bus for internal module communication (tenant events, ingestion events, decisions, audit, alerts) and also needs to integrate with external streaming sources, most notably Ithina's ROOS platform which runs on Kafka.

The obvious question — "should Cortex use Kafka everywhere, given the retail data ecosystem is Kafka-heavy?" — was evaluated against the alternative: Pub/Sub for internal, Kafka at the edges. This ADR captures why we chose the latter.

Three specific forcing functions made this a real decision rather than an abstract one:

1. **ROOS is Kafka.** Cortex must consume from `dis.golden.roos` regardless of what Cortex uses internally. Kafka client code exists in Cortex either way.
2. **Sevyn8 is a small team pre-revenue.** Operational simplicity has real value; hours not spent on Kafka capacity planning are hours on features.
3. **GCP-first architecture.** The v2 spec commits to GCP primary (Cloud SQL, BigQuery, GCS, GKE Autopilot, Dataflow, Vertex AI). Every one of those integrates natively with Pub/Sub; integration with external Kafka is non-native.

## Decision

**Pub/Sub for internal Cortex eventing. Kafka at integration boundaries.**

Specifically:

1. **Internal event backbone: GCP Pub/Sub.** All Cortex-internal topics from the v2 spec (`ingest.raw`, `ingest.canonical`, `quality.events`, `decisions.emitted`, `actions.dispatched`, `consent.changes`, `audit.events`, `alerts`, etc.) run on Pub/Sub.

2. **External streaming integration: Kafka (and other protocols) via G01 connectors.** Any external system that emits via Kafka — starting with ROOS — is consumed through a Kafka connector in G01 Universal Ingestion Gateway. The same connector framework supports other external protocols (webhook, SFTP, JDBC, REST poll).

3. **Kafka ↔ Pub/Sub bridge as a G01 pattern.** External Kafka events enter Cortex, get validated and translated, then land on an internal Pub/Sub topic. From that point, Cortex services only see Pub/Sub. No service outside G01 has a Kafka dependency.

4. **Event bus abstraction package (`@cortex/event-bus`).** All service code publishes and subscribes through a thin internal package, not through the Pub/Sub client directly. This means the internal backbone is swappable in the future without touching service code.

## Rationale

### Where Kafka would have won (and why we chose differently)

- **Portability.** Kafka runs anywhere; Pub/Sub is GCP-only. Accepted as a real constraint — if a future client requires on-prem or AWS deployment, a migration to Kafka is a project, not a switch. The abstraction package limits the blast radius of that future migration.
- **Replay & long retention.** Kafka's log-based model supports long retention and replay from any offset. Pub/Sub max retention is 7 days. Accepted — for Phase 1, 7 days is enough; for bi-temporal replay needs, F03 has its own mechanisms (valid-time + txn-time on stored records). If we hit a real replay use case Pub/Sub can't serve, we add a Kafka log alongside specific high-value topics rather than migrating the whole bus.
- **Ecosystem.** Most retail data players speak Kafka. Addressed by making Kafka a first-class G01 connector, not by making internal Cortex Kafka.
- **Hiring.** More engineers know Kafka than Pub/Sub. Mitigated — the abstraction package means most engineers don't need to know either.

### Where Pub/Sub wins for Sevyn8 today

- **Zero operational overhead.** Fully managed, autoscaling, no partition planning, no capacity management. A small team saves weeks of engineering per year vs operating Kafka (even managed Kafka like Confluent Cloud still requires partition management, ACLs, retention policies, cluster monitoring).
- **Native GCP integration.** One-click from Pub/Sub to Dataflow (S01), Cloud Run, GKE, BigQuery sink, GCS sink, Eventarc. Every one of those requires bespoke connector work with Kafka.
- **Cost at Phase 1 volume.** A minimum-viable Confluent Cloud cluster is $500-800/month baseline. Pub/Sub at Display Data Phase 1 volumes is $20-50/month. We need that capital elsewhere.
- **Simpler security model.** IAM for Pub/Sub vs SASL/ACL management for Kafka.
- **Global replication implicit.** Cross-region availability is built in; we don't build MirrorMaker2.

### What this decision is NOT

- NOT a rejection of Kafka as a technology. Kafka is a first-class external-facing protocol in G01.
- NOT a commitment to Pub/Sub forever. It's the right choice for Phase 1. Phase 3+ may revisit if real requirements emerge.
- NOT a reason to avoid Kafka client code in the repo. G01 will have a robust Kafka consumer with auth, backpressure, schema validation, DLQ handling. Most engineers touching Cortex will be comfortable with both.
- NOT applicable to customer data paths specifically — this is about the *event backbone*. Data plane storage (Cloud SQL, BigQuery, GCS) is a separate concern governed by D01/D06.

## Consequences

### Positive

- Phase 1 engineering time focused on features, not cluster ops
- ROOS integration uses Kafka consumer (well-understood pattern), internal code sees clean Pub/Sub events
- GCP-native integrations work out of the box (S01 Dataflow, O02 alerts, audit sinks to BigQuery)
- Cost footprint appropriate for pre-revenue stage
- Kafka is not banned — it's scoped. Engineers who prefer Kafka for external consumers can build them confidently.

### Negative

- Cortex is not portable to non-GCP environments without real migration work. If a future client requires this, the `@cortex/event-bus` package is the seam; rewriting it is the migration.
- 7-day Pub/Sub retention ceiling. For deeper historical replay, additional mechanisms are needed (archive to BigQuery, or add Kafka alongside specific topics).
- Organizations evaluating Cortex from a "standard stack" lens may prefer Kafka; we need a coherent answer ready (this ADR is that answer).

### Neutral

- Engineers must learn `@cortex/event-bus` abstraction patterns rather than directly using Pub/Sub client APIs. Small learning cost, large future optionality.
- Integration architecture becomes more explicit — G01 is the canonical boundary, which is a good property independent of this decision.

## Alternatives considered

### Alternative 1: Kafka everywhere (including internal Cortex)

Rejected. Operational burden too high for team size and stage. Loses native GCP integrations for Dataflow, Cloud Functions, Eventarc — each would need bespoke bridging. Cost floor ~$500-800/month Confluent Cloud or equivalent self-managed engineering time. No concrete portability or replay requirement in Phase 1 justifies the cost.

### Alternative 2: Pub/Sub everywhere, no Kafka in Cortex

Rejected. ROOS is Kafka; we must consume from it. Pretending Kafka doesn't exist in Cortex means some service outside G01 has to bridge, which leaks the concern. Better to own the boundary explicitly inside G01.

### Alternative 3: Kafka internal, Pub/Sub as a G01 ingestion connector for external webhooks

Considered seriously. Similar architecture, inverse choice. Rejected because (a) the operational cost of running Kafka internally doesn't match Phase 1 stage, (b) Pub/Sub isn't a common external protocol so the "Pub/Sub-as-external-connector" use case is thin, (c) the abstraction layer principle still applies but gains less.

### Alternative 4: NATS or other modern event bus

Rejected without deep evaluation. Not enough ecosystem inertia in retail or enterprise integrations Sevyn8 cares about. Adds a third protocol to support rather than simplifying.

## Implementation pattern

```
External systems (ROOS, partner webhooks, third-party Kafka producers)
            │
            │  ─── various protocols: Kafka, webhook, SFTP, JDBC, REST ───
            ▼
    ┌─────────────────────┐
    │  G01 Ingestion      │   (adapters per protocol)
    │  Gateway            │
    └─────────┬───────────┘
              │
              │  translated to canonical envelope
              ▼
    ┌─────────────────────┐
    │  Pub/Sub Topic:     │
    │  ingest.raw         │
    └─────────┬───────────┘
              │
              ▼
    [G02 Structured Pipeline, S01 Stream Engine, etc.]
              │
              ▼
    [Internal Pub/Sub topics, all consumed via @cortex/event-bus]
```

### The `@cortex/event-bus` package

Location: `/packages/event-bus/`

Public API (simplified):

```typescript
// Publishing
await eventBus.publish<OrderEvent>('decisions.emitted', event, { tenantId });

// Subscribing (long-running worker)
eventBus.subscribe<OrderEvent>('decisions.emitted', async (event, ctx) => {
  // handle event
}, { subscriberGroup: 'action-dispatcher' });

// Request/reply pattern (for synchronous-style internal calls over async bus)
const result = await eventBus.request<QueryRequest, QueryResponse>('queries.entity-lookup', req);
```

Implementation today: Pub/Sub client underneath. The abstraction lets us swap later.

Every internal service uses this package. Direct imports of `@google-cloud/pubsub` are forbidden outside `@cortex/event-bus` itself — enforced by lint rule.

### The G01 Kafka consumer (ROOS pattern)

Location: `/services/ingestion/g01/connectors/kafka/`

- Uses `kafkajs` (mature Node Kafka client)
- Per-source Kafka consumer group per tenant
- Auth via SASL/SSL with credentials from `@cortex/secrets`
- Schema validation via Zod on inbound messages (or Protobuf if ROOS publishes Protobuf)
- Emits to internal Pub/Sub `ingest.raw` topic after validation + envelope
- DLQ for validation failures → separate Pub/Sub topic `ingest.dlq`
- Backpressure via Pub/Sub publish rate — if internal bus slows, Kafka consumer pauses

### The Kafka→Pub/Sub bridge pattern

Implemented as a Cloud Run service (`/services/ingestion/g01/connectors/kafka/bridge/`) that:

1. Subscribes to the configured Kafka topic
2. For each message: validate, enrich with envelope (tenant_id, ingested_at, source_checksum), translate schema if needed
3. Publish to internal Pub/Sub `ingest.raw` with tenant-prefixed message attribute for routing
4. On failure: route to `ingest.dlq` with reason code
5. Emit metrics: consumer lag, bridge throughput, DLQ rate

This service is horizontally scalable; multiple instances share the Kafka consumer group.

## Revisit triggers

This decision should be revisited if any of the following happen:

- A major client requires on-prem or AWS deployment of Cortex (triggers portability question seriously)
- Cortex internal event volumes exceed Pub/Sub's pricing sweet spot (>1B events/month sustained)
- A specific replay use case emerges that Pub/Sub's 7-day retention cannot serve
- GCP pricing or SLA materially shifts
- Team grows past 10 engineers and operational overhead of Kafka becomes proportionally smaller

## References

- GCP Pub/Sub documentation: https://cloud.google.com/pubsub/docs
- Kafka documentation: https://kafka.apache.org/documentation/
- Ithina DIS (ROOS) architecture v13, April 2026 (internal document)
- Cortex v2 Complete System Specification, §F01, §G01, §S01
- `ADR-SCOPE-009-roos-external.md` — companion decision that ROOS stays Ithina-operated

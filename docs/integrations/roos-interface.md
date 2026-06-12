# ROOS ↔ Cortex Integration Contract

**Status:** Draft — pending Ithina coordination
**Version:** 0.1
**Owner (Sevyn8):** Neerj
**Owner (Ithina):** TBD
**Last reviewed:** April 2026
**Governing ADR:** ADR-SCOPE-009

## 1. Event schema

TBD — coordinate with Ithina. Specify Avro vs Protobuf vs JSON; schema registry URL or static schema file location; version policy.

## 2. Tenant identification

TBD — confirm message header field name (placeholder: `ithina_tenant_id`) and mapping to Cortex workspace ids.

## 3. Authentication

TBD — Kafka broker endpoint, SASL mechanism (expected: SCRAM-SHA-256 or SCRAM-SHA-512), credential rotation cadence (quarterly default), Secret Manager path.

## 4. Network topology

TBD — how Cortex (asia-south1 GKE) reaches ROOS. Options: public endpoint with SASL/SSL, VPC peering, private link.

## 5. Throughput targets

TBD — peak events/second Cortex must sustain, average events/day, burst patterns.

## 6. Latency SLA

TBD — time budget from ROOS receiving a POS webhook to the canonical event being available to Cortex.

## 7. Schema evolution

TBD — how ROOS notifies Cortex of schema changes; additive vs breaking change policy; deprecation lead time.

## 8. Error / backpressure

TBD — behaviour when Cortex consumer lags; behaviour when ROOS is down; joint incident response.

## 9. Observability

TBD — shared dashboards, joint runbook URLs, consumer group naming convention.

## 10. Change management

TBD — on-call contacts both sides, escalation path, joint incident review cadence, quarterly review of this contract.

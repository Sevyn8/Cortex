# P0.6: Observability baseline — Scope

**Status:** Scoping complete, implementation queued  
**Scoped:** 2026-04-23  
**Primary sources:** `docs/build-prompts/cortex_build_prompts_v3.md` §P0.6 (lines 580–619), Cortex v2.2 Spec §OB01  
**Companion ADR:** ADR-OBS-001 (observability baseline architecture)

---

## Context

P0.6 delivers Cortex's observability substrate. Two distinct surfaces: developer-facing (library services import) and operator-facing (alerts and dashboards that wake us up). Spec §OB01 prescribes three-dimensional coverage — infrastructure + data quality + AI/ML — all tenant-scoped. Build prompt scopes only the developer library. This scoping document reconciles the two and explicitly marks what's deferred.

## In scope

### Library: `/packages/observability`

Stack: pino (logging) + OpenTelemetry SDK (tracing, OTLP metrics export) + prom-client-compatible metrics API. Auto-injection of `tenant_id`, `user_id`, `request_id`, `trace_id`, `span_id`, `module_id` via a `ContextProvider` interface. Middleware wrappers for HTTP (Express/Fastify), gRPC, and Pub/Sub. PII redaction at logger boundary (spec OB01-FR-002, not in build prompt). Smoke test script emitting log + trace + metric confirming all three reach Cloud Ops.

### Operator infrastructure (Terraform-managed)

Notification channels: email and SMS to Amit and Rahul. Alert policies per environment for Cloud SQL health (CPU sustained, connection count, low storage), CI failures (ci.yaml on main, not PRs), migration failures (GitHub Actions and Cloud Build), budget alerts (per project, 50/80/100% thresholds per runbooks/infrastructure.md:271). Log-based metrics for WIF token exchange failures and Cloud Build submit failures. Three dashboards: Cloud SQL health, CI/CD health, WIF/auth security signals.

### Documentation

Structured logging conventions for services. Runbook entries for responding to each alert type.

## Deferred (explicitly out of scope)

- **Audit chain periodic verifier.** Security-relevant and customer-demo-relevant. Own workstream; tracked separately. Approximately 4–6 hours when picked up.
- **Module-specific metrics.** G01–G06 ingestion lag, D02 mapping throughput, I01 identity resolution latency, A02 algorithm execution, AC03 consent check latency, O03 cache hit rate. These land with their owning modules (Phase 1+).
- **Data quality metrics.** DQI trends, schema drift, freshness. Requires data pipelines to exist (Phase 1).
- **AI/ML metrics.** Model drift, prediction distribution, inference latency. Requires models to exist.
- **O02 alert routing integration.** Spec OB01-FR-004. O02 is a Phase 5 module. Alerts in P0.6 route directly to email/SMS; retargeting to O02 when it exists is trivial config.
- **Default VPC cleanup.** ADR-INFRA-003 follow-up. Separate housekeeping commit; doesn't belong in P0.6.
- **SLO definitions.** Need real traffic to ground the numbers. Revisit when F-series services carry tenant load.
- **Incident response playbooks.** Premature without real incidents to reference. Placeholder in runbooks; filled out as incidents happen.

## Sequencing

1. **Cloud Monitoring stack first.** Gives operator visibility on current infrastructure before any services exist. High value immediately.
2. **Library package second.** Value unlocks when F01+ services consume it. Land after infrastructure alerts are working.
3. **Dashboards third.** Built on real metrics that the library emits.

Rationale: operator visibility is the longest-latency value (need it today, don't have it). Library value is gated on services existing anyway.

## ADRs expected

- **ADR-OBS-001** — Observability baseline architecture (stack selection, ContextProvider interface, library vs operator split, sequencing)
- **ADR-OBS-002** — Cloud Run metric export approach (OTLP via OpenTelemetry; rejected alternatives: GKE-style Prometheus scraping, GCP-Managed Prometheus sidecar)
- **ADR-OBS-003** — PII redaction strategy (redactor boundary, allowlist/denylist configuration, service onboarding pattern)

ADRs 002 and 003 drafted during their respective implementation phases, not up front.

## Time estimate

10–14 hours total across multiple sessions. Breakdown: Cloud Monitoring stack (4–5 hours) + library package with PII redaction (4–6 hours) + dashboards (1–2 hours) + documentation and runbook entries (1 hour).

## Known gotchas

- **Cloud Run vs GKE.** Build prompt says "auto-scraped by GKE." Cortex runs on Cloud Run. Decision: OTLP export via OpenTelemetry SDK. Keeps developer API clean; GCP ingests natively. Documented in ADR-OBS-002 when that phase lands.
- **ContextProvider before F01/AC01.** Build prompt assumes `tenant_id` comes from F01 middleware and `user_id` from AC01 middleware. Both deferred to later phases. P0.6 defines the interface; F01 and AC01 satisfy it when they arrive.
- **PII redaction mandate.** Spec OB01-FR-002 requires it. Build prompt omits. We scope it in per spec; implementation in ADR-OBS-003.

## Open questions (to resolve during implementation)

- Exact PII field taxonomy (log-time denylist) — shaped by which services land first
- Dashboard layout — iterate based on actual alert traffic
- Alert threshold values — start conservative, tune as signals accumulate

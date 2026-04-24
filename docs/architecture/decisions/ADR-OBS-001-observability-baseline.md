# ADR-OBS-001: Observability baseline architecture

**Status:** Accepted  
**Date:** April 2026  
**Deciders:** Amit (Sevyn8 engineering)  
**Context documents:** `docs/build-prompts/cortex_build_prompts_v3.md` §P0.6, Cortex v2.2 Spec §OB01, `docs/planning/p0-6-observability-scope.md`  
**Companion decisions:** ADR-OBS-002 (Cloud Run metric export, drafted during implementation), ADR-OBS-003 (PII redaction strategy, drafted during implementation)

---

## Context

Cortex needs observability before the first service lands. Two surfaces: a library package services import (`@cortex/observability`) and operator-facing alerts/dashboards. Spec §OB01 demands tenant-scoped coverage across infrastructure, data quality, and AI/ML signals. Build prompt scopes only the library. Reality-check: services don't exist yet; operator visibility on current infrastructure is the immediate need.

Three decision axes forced by this context: stack selection, interface design for context injection (tenant_id et al. before F01/AC01 exist), and sequencing of library vs operator work.

## Decision

### 1. Stack

**pino** for logging. **OpenTelemetry SDK** for tracing and metric export. **prom-client-compatible API surface** for developer ergonomics, with OTLP export to Cloud Monitoring (not Prometheus scraping — Cloud Run is the compute plane, not GKE).

### 2. Context injection via `ContextProvider` interface

Library defines a `ContextProvider` interface that exposes `tenant_id`, `user_id`, `request_id`, `trace_id`, `span_id`, `module_id`. Middleware (HTTP, gRPC, Pub/Sub) populates context per request. F01 (tenant resolution) and AC01 (user authentication) implement provider satisfaction when they land. Library is usable today with a stub provider returning undefined for tenant/user — logs degrade gracefully.

### 3. Sequencing: Cloud Monitoring stack first, library second

Infrastructure alerts are high-latency value — we need them today, we don't have them. Library is zero value until services consume it (F01+). Land operator infrastructure first; library follows when its consumers are closer.

### 4. Alerts route to email + SMS (Amit and Rahul) directly, not via O02

O02 is a Phase 5 module. Alerts routed through Cloud Monitoring notification channels directly. When O02 lands, retarget is config-only.

### 5. PII redaction at logger boundary

Spec OB01-FR-002 mandates automatic PII sanitization. Implement at the logger layer so no service can accidentally log PII. Configurable allowlist/denylist, documented in ADR-OBS-003 during its implementation phase.

### 6. Tenant-scoping at library level, not infrastructure level

Cloud Monitoring metrics for Cloud SQL / Cloud Build / Cloud Run are ingested by GCP without tenant context. Per-tenant metrics come from the library (application-emitted), tagged with `tenant_id` via the ContextProvider. Infrastructure metrics remain infrastructure-scoped.

## Rationale

**pino over alternatives (winston, bunyan, console.log + JSON.stringify):** pino is the performance-oriented structured logger standard in Node. ~10x faster than winston. First-class support for child loggers (context inheritance), redaction, and async destinations. Ecosystem support for pretty-printing in dev without production overhead.

**OpenTelemetry over native Cloud Trace SDK or Jaeger client:** vendor-neutral. Swappable backends if we ever move off GCP. Cloud Trace is just an OTLP endpoint — no lock-in. Tracing instrumentation libraries for common frameworks (pg, http, grpc) work out of the box.

**prom-client API, OTLP transport:** developer ergonomics of prom-client (Counter, Histogram, Gauge with `inc()`, `observe()`, `set()`) matched to OTLP export because Cloud Run can't auto-scrape. Best of both worlds. Documented in ADR-OBS-002 with the rejected alternatives (GKE-managed Prometheus, sidecar-based scraping).

**ContextProvider interface:** decouples library from F01/AC01 which don't exist yet. Library ships today with stub. When middleware lands, it satisfies the interface. No retrofit required.

**Cloud Monitoring stack first:** operator visibility today has real value (we ship infrastructure that currently emits no alerts). Library value is gated on services consuming it. Sequence follows value realization.

## Consequences

### Positive

- Observability usable by the first service (F01) with a one-line import, no infrastructure changes required.
- Operator alerts on Cloud SQL, CI, and migration failures land before any tenant traffic — we can sleep knowing infrastructure breakage pages us.
- Stack is swappable: OpenTelemetry is the vendor-neutral bridge. If a future decision moves metrics to Grafana Cloud or logs to Datadog, the export layer changes, not the developer API.
- PII redaction at substrate means services inherit compliance-by-default.

### Negative

- Three libraries (pino, OpenTelemetry SDK, prom-client or equivalent) increase dependency surface. Each needs version pinning and update discipline.
- OTLP export to Cloud Monitoring has less ecosystem documentation than classic Prometheus scraping. Expected to be documented-enough; risk flagged in ADR-OBS-002.
- Tenant-tagged metrics only from application layer. Infrastructure-only metrics (Cloud SQL CPU, Cloud Build duration) are not per-tenant. Acceptable given pre-revenue state; re-evaluate when multi-tenant traffic arrives.

### Neutral

- Library lives under `/packages/observability`; matches existing monorepo convention.
- Alerts targeting email/SMS today will need retargeting to O02 in Phase 5. ~30 minutes of config work when that time comes.

## Scope reconciliation process

This ADR reconciles three sources that diverged: the build prompt §P0.6 (implementation spec), Cortex v2.2 Spec §OB01 (functional spec), and current production reality (Cloud Run not GKE, services not yet built, pre-revenue traffic).

Rather than pick one source and ignore the others, we enumerated each divergence explicitly, chose a resolution, and recorded the reasoning here and in `docs/deviations.md`.

### Divergences found

**(1) Compute plane: GKE vs Cloud Run.** Build prompt assumes GKE Prometheus scraping. Current infrastructure runs on Cloud Run. Resolution: OTLP export via OpenTelemetry SDK (details in ADR-OBS-002 when that phase lands). Developer-facing prom-client API preserved; transport layer changes.

**(2) PII redaction: mandated vs omitted.** Spec OB01-FR-002 requires automatic PII sanitization. Build prompt omits. Resolution: scope-in per spec. Substrate-level redaction is structurally safer than per-service vigilance. Implementation deferred to ADR-OBS-003 in that phase.

**(3) Alert routing: O02 vs direct.** Spec OB01-FR-004 routes alerts through O02. O02 is Phase 5, doesn't exist. Resolution: email + SMS direct via Cloud Monitoring notification channels. Retargeting to O02 when it lands is config-only (~30 min).

**(4) Scope boundary: library-only vs library + operator infrastructure.** Build prompt scopes only the `/packages/observability` library. Current need is operator visibility on existing infrastructure before any services consume a library. Resolution: scope-in operator infrastructure (alert policies, notification channels, dashboards, budget alerts). Sequenced first because its value unlocks immediately; library value is gated on services existing.

**(5) Tenant-scoped metrics: all vs application-layer only.** Spec requires all metrics tenant-scoped. Infrastructure metrics from GCP (Cloud SQL CPU, Cloud Build duration) cannot be tenant-tagged at ingestion. Resolution: tenant-scope application metrics via ContextProvider + library; accept infrastructure metrics as infrastructure-scoped. Re-evaluate at multi-tenant traffic inflection.

**(6) ContextProvider dependencies: F01/AC01 vs not-yet-built.** Build prompt assumes tenant_id from F01 middleware and user_id from AC01 middleware. Both deferred to later phases. Resolution: define ContextProvider interface in P0.6; ship library with stub provider; F01 and AC01 satisfy the interface when they arrive. No retrofit.

### How these were chosen

For each divergence: listed build prompt position, spec position, current reality, candidate resolutions, and selection criteria (spec-alignment, shipability-today, reversibility, compliance). Selections skewed toward (a) honoring spec on compliance-relevant items (PII redaction) and (b) pragmatic deferral on items that genuinely can't ship today (O02 routing). Reasoning captured per-divergence in "Decision" and "Alternatives considered" sections above.

### Recording mechanism

- This ADR is the architectural decision record — authoritative for "what we decided and why"
- `docs/planning/p0-6-observability-scope.md` is the scope delineation — authoritative for "what's in, what's out, what order"
- `docs/deviations.md` is the cross-phase catalog — one row per divergence across all phases, linking back to ADRs
- `docs/build-prompts/cortex_build_prompts_v3.md` §P0.6 gets a scope-delta header pointing to this ADR as authoritative
- Cortex v2.2 Spec §OB01 is NOT edited (external-facing document); deviations.md is the reconciliation layer

Future phases follow the same pattern when source documents diverge.

## Alternatives considered

**winston instead of pino.** Broader ecosystem but significantly slower. Rejected on performance; at expected scale (100+ req/s per tenant), winston's overhead compounds.

**Native Cloud Trace / Cloud Logging SDKs, no OpenTelemetry.** Simpler today. Locks us to GCP for observability. Rejected: vendor-neutrality is a pre-commitment the startup can afford now and cannot afford later.

**prom-client with Prometheus scraping (literal spec interpretation).** Would require GKE or a scrape-sidecar on Cloud Run. Adds complexity (sidecar management, network configuration). Rejected: OTLP export is the cleaner path on Cloud Run; prom-client's developer API is preserved.

**Skip PII redaction in P0.6, handle per service.** Matches build prompt. Rejected: spec mandates it, and substrate-level redaction is structurally safer than per-service vigilance. The spec-vs-build-prompt gap is not evidence the spec is wrong.

**Build library first, defer operator alerts.** Matches build prompt sequencing. Rejected: operator visibility has immediate value; library value is gated on services. Flipping the sequence delivers value earlier.

**Route alerts to O02 now (skip direct email/SMS).** Spec-aligned. Rejected: O02 doesn't exist. Cannot depend on Phase 5 module in Phase 0.

## Implementation notes

### Observation — notification_rate_limit only valid on condition_matched_log policies (P0.6 Phase 1 discovery)

GCP's Cloud Monitoring API rejects notification_rate_limit on alert policies whose conditions use condition_threshold against log-based user metrics (metric.type starts with logging.googleapis.com/user/). The API error: "only log-based alert policies may specify a notification rate limit."

The term "log-based alert policy" in this error message refers specifically to policies using condition_matched_log — not to policies that reference log-based metrics via condition_threshold. The distinction is at the condition type, not at whether the metric originates in logs.

First encountered when applying P0.6 Phase 1 monitoring module — wif_auth_failures and cloud_build_submit_failures policies (both condition_threshold on user-defined log-based metrics) were rejected. Fix: removed notification_rate_limit blocks from those policies. Natural deduplication comes from the 3600s alignment window + ALIGN_SUM + fixed threshold — the condition fires once when the rolling hour sum crosses the threshold and remains firing until it drops below.

cloud_build_failures uses condition_matched_log directly (not a log-based metric), which GCP correctly recognizes as log-based and accepts the rate_limit.

**Rule:** notification_rate_limit only on condition_matched_log. For condition_threshold against log-based user metrics, rely on alignment window semantics for deduplication.

## References

- Cortex v2.2 Spec §OB01 (Platform Observability Stack, FR-001 through FR-004)
- Build prompt §P0.6 (Observability baseline)
- P0.6 scoping document: `docs/planning/p0-6-observability-scope.md`
- ADR-INFRA-006 (WIF federation — source of WIF failure metrics tracked in P0.6)
- ADR-CI-001 (migration runner — source of Cloud Build submit failure metrics tracked in P0.6)

# Cortex — Phase deviations catalog

## Purpose

Cortex has three authoritative source documents that occasionally diverge during implementation:

1. **Cortex v2.2 Spec** (`docs/spec/cortex_v2.2.docx`) — functional specification. External-facing, describes what Cortex promises customers and stakeholders.
2. **Build prompts** (`docs/build-prompts/cortex_build_prompts_v3.md`) — implementation spec. Per-phase prompts that drive development.
3. **Production reality** — current infrastructure state, deferred items from prior phases, tools/platforms selected.

When these diverge during a phase, we reconcile explicitly rather than silently. This document is the catalog — one row per divergence, pointing to the ADR that captures the full reasoning.

## How to use

- **Writing code that references spec §OB01 (or any other spec section)?** Check this document first. The spec may have been superseded for implementation.
- **Writing a new ADR?** If your decisions diverge from spec or build prompt, add rows to this document with links to your ADR.
- **Spec update meeting with stakeholders?** This document is the list of "what shipped differently from spec and why" — useful input for spec v2.3 or v3.

## Catalog

| Phase | Divergence                    | Build prompt / Spec said                                  | We shipped                                                                            | Reason                                                                                        | Authoritative source                                                 |
| ----- | ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P0.6  | Compute plane metric scraping | GKE Prometheus scraping (build prompt)                    | OTLP export via OpenTelemetry SDK                                                     | Cortex compute is Cloud Run, not GKE                                                          | ADR-OBS-001 §Decision 1, ADR-OBS-002 (forthcoming)                   |
| P0.6  | PII redaction in logs         | Not mentioned (build prompt); mandated (spec OB01-FR-002) | Scoped in to P0.6 library                                                             | Substrate-level redaction is structurally safer than per-service. Spec mandate honored.       | ADR-OBS-001 §Decision 5, ADR-OBS-003 (forthcoming)                   |
| P0.6  | Alert routing                 | Through O02 (spec OB01-FR-004)                            | Email + SMS direct via Cloud Monitoring                                               | O02 is Phase 5, doesn't exist yet. Retargeting is trivial config when O02 lands.              | ADR-OBS-001 §Decision 4                                              |
| P0.6  | Scope boundary                | Library only (build prompt)                               | Library + operator infrastructure + dashboards                                        | Operator visibility has immediate value; library value gated on services existing             | ADR-OBS-001 §Decision 3, `docs/planning/p0-6-observability-scope.md` |
| P0.6  | Tenant-scoping of metrics     | All metrics tenant-scoped (spec OB01-FR-001/003)          | Application-layer metrics tenant-scoped; infrastructure metrics infrastructure-scoped | GCP-ingested infra metrics can't be tenant-tagged at source. Revisit at multi-tenant traffic. | ADR-OBS-001 §Decision 6                                              |
| P0.6  | ContextProvider source        | F01/AC01 middleware (build prompt)                        | Interface defined in P0.6; stub provider ships now; F01/AC01 satisfy later            | F01 (P1.1) and AC01 (P2.1) not yet built. Library ships usable today.                         | ADR-OBS-001 §Decision 2                                              |

## Process notes

- Add to this catalog WHEN divergence is decided, not after implementation
- Each row links to the ADR that contains reasoning; don't duplicate reasoning here
- If a spec section is superseded by multiple ADRs (happens on large modules), list each with its ADR
- When spec is next revised (v2.3, v3, etc.), use this catalog to identify sections needing update

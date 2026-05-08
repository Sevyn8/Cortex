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

| Phase   | Divergence                    | Build prompt / Spec said                                  | We shipped                                                                            | Reason                                                                                                                                                                                                                          | Authoritative source                                                 |
| ------- | ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P0.6    | Compute plane metric scraping | GKE Prometheus scraping (build prompt)                    | OTLP export via OpenTelemetry SDK                                                     | Cortex compute is Cloud Run, not GKE                                                                                                                                                                                            | ADR-OBS-001 §Decision 1, ADR-OBS-002 (forthcoming)                   |
| P0.6    | PII redaction in logs         | Not mentioned (build prompt); mandated (spec OB01-FR-002) | Scoped in to P0.6 library                                                             | Substrate-level redaction is structurally safer than per-service. Spec mandate honored.                                                                                                                                         | ADR-OBS-001 §Decision 5, ADR-OBS-003                                 |
| P0.6    | Alert routing                 | Through O02 (spec OB01-FR-004)                            | Email + SMS direct via Cloud Monitoring                                               | O02 is Phase 5, doesn't exist yet. Retargeting is trivial config when O02 lands.                                                                                                                                                | ADR-OBS-001 §Decision 4                                              |
| P0.6    | Scope boundary                | Library only (build prompt)                               | Library + operator infrastructure + dashboards                                        | Operator visibility has immediate value; library value gated on services existing                                                                                                                                               | ADR-OBS-001 §Decision 3, `docs/planning/p0-6-observability-scope.md` |
| P0.6    | Tenant-scoping of metrics     | All metrics tenant-scoped (spec OB01-FR-001/003)          | Application-layer metrics tenant-scoped; infrastructure metrics infrastructure-scoped | GCP-ingested infra metrics can't be tenant-tagged at source. Revisit at multi-tenant traffic.                                                                                                                                   | ADR-OBS-001 §Decision 6                                              |
| P0.6    | ContextProvider source        | F01/AC01 middleware (build prompt)                        | Interface defined in P0.6; stub provider ships now; F01/AC01 satisfy later            | F01 (P1.1) and AC01 (P2.1) not yet built. Library ships usable today.                                                                                                                                                           | ADR-OBS-001 §Decision 2                                              |
| P0.6    | Request-id field name         | `request_id` (build prompt §P0.6)                         | `correlation_id` everywhere (ContextProvider, log field, OTel span attr, header)      | Aligns with broader observability convention; `x-request-id` accepted as a fallback extractor.                                                                                                                                  | ADR-OBS-001 §Decision 2, `docs/future-roadmap.md` §9.8               |
| F02 D.4 | Firewall posture rule count   | Four rules per VPC (ADR-INFRA-003 original)               | Five rules per VPC (added `cortex-allow-internal-egress` priority 1050)               | F02 D.4 surfaced that connector-egressed traffic to Cloud SQL PSA range had no allow against the default-deny at 65534. Cloud Run `tenant-lifecycle-shared` returned 500 on /v1/tenants until the rule was added in all 3 envs. | ADR-INFRA-003 §Firewall posture (amended 2026-05-08)                 |

## Process notes

- Add to this catalog WHEN divergence is decided, not after implementation
- Each row links to the ADR that contains reasoning; don't duplicate reasoning here
- If a spec section is superseded by multiple ADRs (happens on large modules), list each with its ADR
- When spec is next revised (v2.3, v3, etc.), use this catalog to identify sections needing update

## bi-temporal test flake — cortex_scd_trigger DELETE branch (Resolved 2026-04-25)

**Status:** Resolved 2026-04-25 / commit `180c849` / `services/foundation/migrations/0006_bi_temporal_ms_truncation.sql`.

### Summary

`services/foundation/test/bi-temporal.spec.ts` intermittently failed on CI (e.g., runs 24837833606, 24884652888, 24893617678) with `expected [] to have a length of 1 but got +0` on the DELETE-branch as-of-prior assertion. Diagnostic instrumentation in commit `2604c85` captured the smoking gun in failing run 24893617678: `T_I=…867135+00, T_S=…867851+00, before=…867Z, rows=0` — INSERT and `SELECT now()` landed in the same millisecond, the JS-`Date`-round-tripped `before` truncated µs to `.867000`, and the closed-lower-bound predicate `[867135, …) ⊇ 867000` evaluated FALSE.

The flake was µs-vs-ms precision asymmetry between Postgres `timestamptz` (µs) and JS `Date` (ms), surfacing only when the system clock didn't cross a ms boundary between the trigger-side `now()` and the test-side `SELECT now()`.

### Fix

Migration 0006 (`bi_temporal_ms_truncation.sql`) wraps every Postgres-side `now()` consumer in `date_trunc('millisecond', now())`: the SCD trigger's INSERT/UPDATE/DELETE branches plus the `txn_time` / `valid_time` `DEFAULT` expressions. The whole-system temporal quantum now matches JS-`Date` precision; the round-trip is lossless by design. µs-precision audit (2026-04-25) confirmed no consumer of `txn_time` / `valid_time` reads sub-ms; the audit chain's µs dependency is on `audit_event.occurred_at`, a separate column untouched by the SCD trigger.

### Prevention

Migration 0007 (control-plane tables, F01 Slice A) and any future tables with bi-temporal or wall-clock-default columns should default via `date_trunc('millisecond', now())` rather than bare `now()`. The pattern is established and exercised by 41 foundation tests + 65 tenant-context tests as of 2026-04-25.

## P0.6 Phase 8 — operator-validation observations

### Email channel verification deferred

All 9 email notification channels (3 recipients × 3 envs) remain in `verificationStatus: NOT_SET`. GCP requires a manual code-entry flow per channel (`sendVerificationCode` via REST, then paste code back via UI), which has disproportionate cost for current operational value:

- CRITICAL alerts route to email + Chat (Chat delivery proven end-to-end at 2026-04-24 via direct webhook test, HTTP 200)
- WARNING alerts route to email only (current impact: zero — no real traffic, no incidents to miss)
- Verification is trivial to complete later (one gcloud + UI session per channel) if email delivery becomes operationally needed

Not blocking P0.7 or any downstream work. Will address if email alerts become useful after F-series ships services that produce real traffic.

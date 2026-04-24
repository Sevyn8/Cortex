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

## bi-temporal test flake — cortex_scd_trigger DELETE branch

### Symptom

`services/foundation/test/bi-temporal.spec.ts:153` — "cortex_scd_trigger on DELETE > closes old row; no new row; as-of prior returns value, as-of now returns nothing" intermittently fails on CI with:

```
AssertionError: expected [] to have a length of 1 but got +0
  at test/bi-temporal.spec.ts:153:30
```

### Occurrences

- Commit 8581b0f, CI run 24837833606 — failed once, passed on retry
- Commit 703878f (P0.6 Phase 1), CI runs 24884652888 + rerun — failed twice consecutively

### Working hypothesis (unconfirmed)

JS Date has millisecond precision; Postgres timestamptz has microsecond. When the test captures `SELECT now() AS t` and the pg client uses default type parsers, the returned JS Date truncates microseconds. If the INSERT's DEFAULT `tstzrange(now(), NULL)` and the subsequent `SELECT now()` fall in the same millisecond, the round-tripped `before` value (passed back as `$1::timestamptz`) can land BEFORE the recorded INSERT lower bound — causing `txn_time @> before` to evaluate FALSE on the closed lower boundary, returning zero rows.

### Why unconfirmed

Local repro attempted against pgvector/pgvector:pg17 (same image CI uses) on WSL2 Docker Desktop:

- 100/100 passes on standalone JS script mirroring the test exactly
- 30/30 passes on real `vitest run test/bi-temporal.spec.ts`

Did not reproduce. Flake is likely CI-runner-specific — GitHub Actions ephemeral VM clock/scheduling, or state interaction from running `audit-chain.spec.ts` + `rls.spec.ts` before `bi-temporal.spec.ts` in the same vitest invocation.

### Candidate fixes

**(A) Trigger-layer fix (production-grade):** Wrap all Postgres-side `now()` calls in `date_trunc('millisecond', now())` — SCD trigger (both UPDATE and DELETE branches) and table DEFAULT expressions. Aligns whole-system temporal quantum with JS Date precision.

**(B) Test-layer fix (narrow):** Change `SELECT now() AS t` → `SELECT now()::text AS t_str`, pass back as `$1::timestamptz`. Preserves microsecond precision on round-trip. Minimal surface but only fixes this test.

**(C) Diagnostic approach:** Add temporary stderr logging for T_I, T_D, T_S_raw, and `before` in the failing test, commit, wait for the flake to recur in CI, diagnose from real data.

### Unresolved anomaly

The analogous UPDATE test (same structure: INSERT → SELECT now() → sleep → UPDATE → predicate with `before`) consistently passes. Under the hypothesis, it should be equally flaky. Reason to prefer (C) — instrument and wait for real data — before committing (A) or (B) blind.

### Recommended path (next session)

1. Option (C) first — add diagnostic logging (5-line test edit), commit, let CI flake naturally, capture real T_I vs before delta
2. Once hypothesis confirmed or refuted, apply the appropriate fix
3. If (A) is chosen, audit all other Postgres-side `now()` usage across the codebase for the same issue class

### Notes

- This flake pre-dates P0.6 Phase 1. Commit 703878f is not the cause; it only made the flake more visible.
- Main is red on the flake as of 2026-04-24. GCP infrastructure from P0.6 Phase 1 is correctly applied and working — CI red does NOT indicate broken infrastructure.

## P0.6 Phase 8 — operator-validation observations

### Email channel verification deferred

All 9 email notification channels (3 recipients × 3 envs) remain in `verificationStatus: NOT_SET`. GCP requires a manual code-entry flow per channel (`sendVerificationCode` via REST, then paste code back via UI), which has disproportionate cost for current operational value:

- CRITICAL alerts route to email + Chat (Chat delivery proven end-to-end at 2026-04-24 via direct webhook test, HTTP 200)
- WARNING alerts route to email only (current impact: zero — no real traffic, no incidents to miss)
- Verification is trivial to complete later (one gcloud + UI session per channel) if email delivery becomes operationally needed

Not blocking P0.7 or any downstream work. Will address if email alerts become useful after F-series ships services that produce real traffic.

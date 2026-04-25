# ADR-OBS-003: PII redaction strategy for structured logs

**Status:** Accepted  
**Date:** April 2026  
**Deciders:** Amit (Sevyn8 engineering)  
**Context documents:** ADR-OBS-001 §Decision 5, Cortex v2.2 Spec §OB01-FR-002, `packages/observability/src/redaction.ts`  
**Companion decisions:** ADR-OBS-001 (observability baseline)

---

## Context

`@cortex/observability` emits structured JSON logs via pino. Logs are the most common accidental PII-leak vector in a service-oriented codebase: a developer logs a request body or user object for debugging, ships the line, and the value-bearing fields land in Cloud Logging where they persist for the retention window and propagate to anyone with project read access.

Cortex's regulatory context bites here: India's DPDP Act, RBI norms for fintech-adjacent processing, and sectoral data-localization requirements all expect "reasonable safeguards" against PII exposure in operational logs. Spec OB01-FR-002 mandates automatic PII sanitization at the logger boundary; ADR-OBS-001 §Decision 5 commits to substrate-level redaction so no service can opt out by accident.

Pino offers two redaction approaches, and we have to pick one for Phase 2:

1. **Path-based.** Caller declares JSON paths (e.g., `'*.password'`, `'req.headers.authorization'`); pino looks up those paths on every log object and replaces matched values with a censor string (`'[REDACTED]'`). Lookup cost is O(declared paths) per log line.
2. **Value-based.** Regex-scan log values for patterns matching PII formats (e.g., 16-digit credit-card numbers, email-shaped strings, UUIDs that match Aadhaar's geometry). Matches anywhere in the structure, regardless of field name. Cost is O(log volume × patterns × value sizes).

We need to commit to one before any service starts emitting; once consumers fan out, swapping is expensive.

## Decision

**Phase 2 ships path-based redaction only.** `DEFAULT_REDACTION_PATHS` in `packages/observability/src/redaction.ts` covers four categories:

- **Credentials** (13 paths): `*.password`, `*.api_key`, `*.apiKey`, `*.token`, `*.access_token`, `*.accessToken`, `*.refresh_token`, `*.refreshToken`, `*.secret`, `*.client_secret`, `*.clientSecret`, `*.private_key`, `*.privateKey`.
- **Personal identifiers** (9 paths): `*.email`, `*.phone`, `*.phone_number`, `*.phoneNumber`, `*.ssn`, `*.aadhaar`, `*.aadhar`, `*.pan`, `*.pan_number`. Indian-context PII (Aadhaar, PAN) explicitly enumerated alongside the international set.
- **Payment instruments** (6 paths): `*.credit_card`, `*.creditCard`, `*.card_number`, `*.cardNumber`, `*.cvv`, `*.iban`.
- **HTTP request/response headers** (5 paths): `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `req.headers["x-cortex-tenant-id"]`, `res.headers["set-cookie"]`. Tenant id header is redacted defensively to prevent cross-tenant leakage in shared-log dumps.

Caller-supplied `extraRedactionPaths` are concatenated to the defaults — extension only, never subtraction. The default set is the minimum safe baseline.

## Rationale

**Performance.** Path-based redaction is O(declared paths) per log line — pino looks up each declared path and substitutes if present. Value-based scans every value in every nested structure against every pattern; at the canonical Cortex log volume (estimated 10–100 lines/request × 10–100 RPS at growth), the regex-scan tax is non-trivial and grows with both traffic and pattern count.

**False-positive risk.** Value-based regex flags any substring that matches a pattern. Real-world examples:

- `'4111111111111111'` matches a credit-card-shape regex but is also a common Stripe test card embedded in error messages, fixture dumps, or replayed in customer-support traces.
- A 12-digit numeric Aadhaar pattern matches plenty of legitimate IDs: order numbers, internal sequence keys, telemetry counters.
- Email-shaped strings appear in `From:` / `To:` headers of test data, fake auth-flow logs, and stack traces from libraries.

Each false positive either (a) corrupts a debugging payload by hiding the value an operator needs, or (b) trains operators to ignore `[REDACTED]` markers, eroding the signal value of real redactions. Mitigations exist (context-aware regex, allowlists, position-anchored patterns), but each adds complexity and the false-positive rate never reaches zero.

**Coverage.** The canonical leak vector is "developer accidentally passes a value-bearing object to the logger" — `logger.info(user)` where `user` has a `password` field. Path-based catches this if the developer uses standard field names (`password`, `apiKey`, `email`). Cortex's @cortex/\* convention enforces these names via lint and review, so the catch rate in practice is high.

The residual risk is "developer logs PII at a non-standard path" (e.g., `logger.info({ secret: someToken })` where `secret` happens to be a credential — caught by `*.secret`; or `logger.info({ x_api_token: '...' })` where the field name doesn't match any default — not caught). The mitigation is field-naming discipline plus `extraRedactionPaths` for service-specific extensions.

**Defense-in-depth principle.** Path-based redaction is cheap insurance. Even if a service's field names occasionally drift, the canonical credential / payment / identifier names catch the most common mistakes. We accept the residual coverage gap rather than pay the value-based scan tax.

## Consequences

### Positive

- Hot-path logging stays cheap. Per-line redaction cost is proportional to the (small, constant) number of declared paths, not to log volume × pattern count.
- Indian-context PII (Aadhaar, PAN) is first-class — enumerated explicitly alongside SSN / credit-card / etc. rather than an afterthought.
- Header redaction covers the leakiest channels for credentials (`authorization`, `cookie`, `x-api-key`) at the substrate, so services can log `req` shapes for debugging without leaking auth tokens.
- Extension semantic (`extraRedactionPaths` adds, never subtracts) prevents accidental safety downgrades. A noisy service can extend the set; nobody can shrink it without an explicit decision and ADR amendment.

### Negative

- Phase 2 redaction is path-coverage-bounded. A logged value containing PII at a non-declared path is not redacted. Field-naming discipline + lint + code review + this ADR are the primary defense; the substrate is the safety net for the most common mistakes only.
- Indian PII coverage is not exhaustive — covers Aadhaar (`*.aadhaar`, `*.aadhar`) and PAN (`*.pan`, `*.pan_number`) but not driving-license, passport, voter ID. Coverage extends as services emit those fields. Tracked in the future-roadmap §1.6 alongside the parallel infrastructure tenant-scoping concern.
- No end-to-end PII-leak monitor in Phase 2. If a leak occurs at a non-declared path, we discover it only by manual audit or downstream report. ADR-OBS-003-amendment-1 (future) will revisit if real leaks surface.

### Neutral

- The censor string is the literal `'[REDACTED]'`. Operators searching for redacted occurrences can grep for that constant. Filterable in Cloud Logging via `jsonPayload.<path>:"[REDACTED]"`.
- Configuration lives in `packages/observability/src/redaction.ts` as a `readonly string[]` constant. Adding a path is a one-line PR; tests in `packages/observability/test/redaction.spec.ts` pin the count to 33 so accidental adds/removes are caught at review.

## Alternatives considered

### A. Value-based regex scanning

**Rejected for Phase 2** due to performance and false-positive cost outlined in Rationale. May revisit in a Phase-3 ADR-OBS-003-amendment if leak observability surfaces a need that path-based + naming discipline can't cover. The amendment trigger: ≥1 confirmed PII leak through a non-declared path in production logs over a quarter.

### B. ML-based PII detection (Cloud DLP or equivalent)

**Rejected.** Synchronous DLP API call per log line is prohibitive — both latency (10s of ms per call against an external API) and cost (DLP is priced per 1K chars inspected). Async DLP (post-ingestion sweep on a sampled fraction of logs) is operationally interesting but out of Phase 2 scope; would need a sink-then-scan pipeline that doesn't exist today. Track separately if the leak posture justifies the build.

### C. No redaction (rely on field-naming discipline alone)

**Rejected.** Defense-in-depth principle: path-based redaction is cheap insurance against developer mistake. The substrate cost is a few microseconds per log line; the failure mode without it is "every developer mistake permanently writes PII to Cloud Logging for the retention window." Asymmetric — keep the safety net.

### D. Caller-supplied redaction-only (no defaults)

**Rejected.** Same defense-in-depth reasoning — the default set is the minimum safe baseline. New services should NOT have to opt in to redacting `password` and `authorization`; opting out is the unusual path and requires an explicit decision.

## References

- `packages/observability/src/redaction.ts` — `DEFAULT_REDACTION_PATHS`, `REDACTION_CENSOR`, `buildRedactionConfig`.
- `packages/observability/src/logger.ts` — wires the redaction config into pino at logger construction.
- `packages/observability/test/redaction.spec.ts` — 9 tests verifying path coverage + pino integration (top-level credential redaction, nested wildcard, header redaction, Indian PII, custom extras).
- ADR-OBS-001 §Decision 5 — substrate-level redaction commitment.
- pino redaction docs: https://github.com/pinojs/pino/blob/main/docs/redaction.md
- `docs/deviations.md` row "P0.6 / PII redaction in logs" — links here as the authoritative source.

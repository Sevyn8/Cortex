# Cortex Future Roadmap

Authoritative deferral catalog. Every architectural choice we've consciously
deferred lives here with current state, future options, and trigger criteria.
Updated whenever a deferral is added or revisited.

## How to use this document

- Adding a deferral: pick a section, add an entry with all 5 fields
- Revisiting: search by trigger keyword (tenant count, scale, regulatory, etc.)
- Resolving: keep the entry, add "Resolved YYYY-MM-DD" + commit hash; don't delete

## Sections

1. Tenant-scale triggers — revisit when tenant count or per-tenant traffic crosses thresholds.
2. Operational triggers — revisit when operators ask, alert fatigue arrives, or specific tooling demand emerges.
3. Regulatory / contractual triggers — revisit when DPA, certification, or regulatory mandate arrives.
4. Phase-sequenced — tied to specific named build prompts (P0.10, F02, AC01, P11.x, etc.).
5. First-consumer-driven — lands when the first concrete consumer arrives.
6. Phase 1 explicit cuts — deliberately minimal in Phase 1; full implementation in named later phase.
7. Stub implementations — currently shipped with explicit swap-paths.
8. Code TODOs tied to future phases — grep-able markers in the codebase.
9. Specification deviations — Cortex v2.2 spec deviations we're tracking. Mirrored from `docs/deviations.md` where applicable but listed here for forward planning.
10. Decisions yet to be made — architectural choices F01 (or later modules) will need to make. Listed here so we don't forget them.

## Entry template

```
- **Item:** [name]
- **Current state:** [what we have today]
- **Future options:** [numbered if multiple]
- **Triggers:** [concrete criteria for revisit]
- **References:** [ADR, build prompt, commit, file]
- **Owner phase:** [target phase or "operator-driven"]
```

---

## 1. Tenant-scale triggers

### 1.1 Per-tenant CMEK keys

- **Item:** Per-tenant CMEK key issuance + tenant_id ↔ key binding in D01
- **Current state:** Single `cortex-secrets-key` per env wraps all tenant data. `getKeyForTenant(tenantId)` is a Phase-1 stub returning the env's `cortex-general-key` regardless of `tenantId`.
- **Future options:**
  1. Per-tenant CMEK on creation (D01 stores `tenant_id → key_id`). Additive — new keys, no re-key of existing data.
  2. Per-tenant Cloud EKM (key material outside GCP) for specific tenants demanding sovereign control.
- **Triggers:** Tenant count > ~5 OR a DPA explicitly requires customer-managed key material per tenant OR cryptographic-erasure-on-offboarding is contractually demanded.
- **References:** ADR-INFRA-004 §Decision 5, `packages/secrets/src/per-tenant-keys.ts`, F02 build prompt (P1.2 provisioning steps include "create KMS key").
- **Owner phase:** F02 implementation when triggered.

### 1.2 Cloud SQL Enterprise Plus upgrade

- **Item:** Upgrade Cloud SQL Postgres from Enterprise → Enterprise Plus
- **Current state:** Enterprise edition across dev/staging/prod (per ADR-INFRA-005).
- **Future options:**
  1. Prod-only upgrade to Enterprise Plus (Data Cache, Near-Zero Downtime maintenance, Premium Support).
  2. All-env upgrade.
- **Triggers:** "Paid tenant count justifies it" — pricing delta is ~2.5× and not material at pre-revenue.
- **References:** ADR-INFRA-005 §Rationale.
- **Owner phase:** Operator-driven, post-Display-Data-revenue.

### 1.3 Workload Identity Federation for human operators

- **Item:** WIF-based human auth for Terraform operations
- **Current state:** Personal ADC + cortex-admins group impersonating per-env `cortex-tf-admin` SAs (per ADR-INFRA-002).
- **Future options:** WIF from a corp IdP (Google Workspace OIDC) into env SAs; eliminates per-person credential management.
- **Triggers:** "Team size grows beyond ~3 engineers actively doing infra work." Per-person SA impersonation becomes unwieldy at scale.
- **References:** ADR-INFRA-002 §Revisit triggers.
- **Owner phase:** Operator-driven.

### 1.4 Shared VPC migration

- **Item:** Move from per-project VPCs to a Shared VPC (host + service projects)
- **Current state:** One VPC per env project (dev, staging, prod), each with its own networking module instance.
- **Future options:** Shared VPC with shared host project + service-project attachments.
- **Triggers:** "Project count grows beyond ~6." Operational saving of Shared VPC pays off at scale, not at Phase 1.
- **References:** ADR-INFRA-003 §Revisit triggers.
- **Owner phase:** Operator-driven.

### 1.5 Audit chain concurrent-write protection

- **Item:** Advisory locks / chain-tail table / partial unique index for audit_event SHA-chain
- **Current state:** Per-tenant SHA chain via SCD trigger; no lock — concurrent INSERTs to the same tenant can fork the chain.
- **Future options:**
  1. PG advisory lock per tenant on INSERT.
  2. `chain_tail` table with single row per tenant, foreign-key referenced by audit_event.
  3. Partial unique index on (tenant_id, prev_hash) WHERE next_event IS NULL.
- **Triggers:** Any tenant exceeds ~10 audit events/sec sustained OR SCR-20 audit log surfaces an actual fork.
- **References:** ADR-DB-003 Implementation notes.
- **Owner phase:** SCR-20 (P8.12) or earlier if observed.

### 1.6 Per-tenant metrics tagging at infrastructure layer

- **Item:** Tagging GCP-ingested infrastructure metrics (Cloud SQL CPU, Cloud Build duration) with `tenant_id`
- **Current state:** Application-emitted metrics tenant-tagged via OpenTelemetry; infrastructure metrics remain infrastructure-scoped (per ADR-OBS-001 §Decision 6).
- **Future options:** Custom OTLP pipeline that re-tags infra metrics by inspecting workload labels.
- **Triggers:** Multi-tenant traffic inflection (multiple tenants with material per-tenant resource consumption variance worth observing).
- **References:** ADR-OBS-001 §Decision 6.
- **Owner phase:** Operator-driven post-multi-tenancy.

### 1.7 OTel auto-instrumentation cost review at scale

- **Item:** Cost ceiling on the SDK's default-on auto-instrumentations (HTTP / gRPC / pg / Redis / fs / dns)
- **Current state:** `initObservabilitySdk` enables all `getNodeAutoInstrumentations()` by default; Phase 1 cost analysis assumed <10 services × <10 RPS × free-tier ingestion. At current scale the per-month export bill is $0–100.
- **Future options:** (a) Selective opt-out via the `enableAutoInstrumentations: false` knob already exposed; (b) sampling at the collector layer; (c) per-instrumentation enable list passed through the SDK options.
- **Triggers:** ≥50 services in production, sustained traffic, or any single month where Cloud Trace ingestion + Cloud Monitoring metric writes attributable to instrumentation cross $200. Build a cost dashboard and review monthly once F-series ships.
- **References:** `packages/observability/src/sdk.ts` (`enableAutoInstrumentations` option), ADR-OBS-001 §Decision 1.
- **Owner phase:** Operator-driven post-F-series; revisit at the first traffic inflection.

### 1.8 Per-tenant log-emission rate limiting

- **Item:** Token-bucket rate limit on log emission, sized per tenant
- **Current state:** No per-tenant cap. A noisy tenant (debug log loop, runaway error retry) can dominate Cloud Logging quota for an entire project, masking other tenants' signals and inflating the bill.
- **Future options:** (a) Rate-limit at the observability HTTP middleware boundary, keyed on `tenant_id` from the async-local store; (b) Cloud Logging exclusion filter at sink level; (c) tenant-aware logger child with a `child.flush` rate gate.
- **Triggers:** First incident where a single tenant's emission rate visibly inflates ingestion cost or competes for Cloud Logging API quota; or routinely >1k log lines/sec from a single tenant.
- **References:** `packages/observability/src/logger.ts`.
- **Owner phase:** First F-series service hitting the issue.

### 1.9 Audit payload size enforcement

- **Item:** Hard cap on `audit_event.payload` size (currently soft 64 KB WARN-only)
- **Current state:** `@cortex/audit-events` logs `WARN` via `@cortex/observability` when canonicalized payload exceeds 64 KB (Decision 2 of P0.10 planning doc). No throw, no truncation. Threshold is a heuristic; observed distribution unknown until F-series consumers emit at volume.
- **Future options:** (a) Hard cap with `AuditEventValidationError` at the library boundary; (b) automatic truncation with a `payload_truncated: true` flag; (c) separate `audit_event_payload_overflow` table for large blobs, FK from `audit_event`; (d) raise the threshold based on observed P95.
- **Triggers:** Sustained WARN rate exceeding ~1% of audit emissions over a month, OR Cloud Logging row-size pressure on `audit_event`, OR a single tenant exceeds 64 KB on >10% of emissions.
- **References:** `docs/planning/p0-10-audit-events-scope.md` Decision 2 (authoritative source for the 64 KB threshold — update this entry if the threshold changes there), `packages/audit-events/src/` (when implemented).
- **Owner phase:** Operator-driven post-F-series; revisit at first observed pressure signal.

### 1.10 p09-repro `__drizzle_migrations` tracking backfill

- **Item:** Reconcile p09-repro's empty `__drizzle_migrations` tracking table with the migrations actually applied via `psql -f`
- **Current state:** p09-repro is psql-bootstrapped — F01 Slice A and P0.10 migrations were applied directly via `psql -f` and the `__drizzle_migrations` table is empty (0 rows). Production envs (dev / staging / prod) go through `make db-migrate-{env}` which uses drizzle-kit and tracks in this table. Result: dev p09-repro and production-apply paths diverge silently. New migrations work in both, but any future operation that depends on tracked state (replay, baseline) would fail differently across environments.
- **Future options:** (a) Backfill `__drizzle_migrations` rows in p09-repro's bootstrap script with synthetic hashes matching what drizzle-kit would write; (b) Migrate p09-repro to drizzle-kit-driven apply (requires reset + replay of all migrations); (c) Document the divergence and accept it for dev convenience.
- **Triggers:** First operator action that depends on tracked-state alignment between dev and production (e.g., a forensic replay of migration order, or a baseline-from-existing-DB workflow). Or any new contributor confused by `pnpm db:migrate` failing locally while succeeding in CI.
- **References:** `services/foundation/migrations/meta/_journal.json`, `drizzle.config.ts`, `Makefile` (db-migrate-\* targets), P0.10 sub-phase 2 finding #1.
- **Owner phase:** First operator-driven trigger.

### 1.11 Unicode-literal hygiene in test fixtures

- **Item:** Convention for using escape-form (`\uXXXX`) instead of bare literals when test fixtures depend on specific Unicode normalization forms
- **Current state:** P0.10 sub-phase 6.4 surfaced silent NFC normalization of bare combining-character literals (`'café'` decomposed → composed) by the editor / write pipeline. The fix is escape sequences (`'cafe\u0301'` for decomposed, `'caf\u00e9'` for composed) — pure ASCII bytes that JavaScript parses to the intended codepoints at runtime, immune to source-file normalization. `packages/audit-events/test/canonicalize.spec.ts` documents the pattern; `schemas.spec.ts` migrated to match (sub-phase 6.4 follow-up).
- **Future options:** (a) Add an ESLint rule banning bare combining characters in `*.spec.ts` files; (b) Document the convention in CLAUDE.md test-conventions section; (c) Convert any future test that depends on specific normalization forms to escape sequences. The bare-literal form is fine for tests that don't depend on the specific normalization (most don't).
- **Triggers:** Any future package adding NFC-dependent tests (Indian-script payloads, accented text validation, hash-determinism asserts). When AC02 / future modules emit logs with international content, this comes up.
- **References:** `packages/audit-events/test/canonicalize.spec.ts` (canonical pattern), `packages/audit-events/test/schemas.spec.ts` (migrated reference).
- **Owner phase:** Convention captured here; future test authors apply where applicable.

---

## 2. Operational triggers

### 2.1 P0.6 Phase 3 dashboards

- **Item:** Cloud Monitoring dashboards linking alert state + tenant-scoped views
- **Current state:** Phase 1 alert policies + notification channels live; no dashboards.
- **Future options:** Build per-env dashboard set (Cloud SQL health + alert state + WIF/CB metrics) when an operator asks for one.
- **Triggers:** Operator requests it during incident-response retrospective, or alert fatigue surfaces and dashboards become the sane way to triage.
- **References:** `docs/progress/status.md` Phase 0 P0.6 entry; ADR-OBS-001.
- **Owner phase:** Operator-driven, deferred indefinitely.

### 2.2 Email channel verification

- **Item:** Verify all 9 email notification channels (3 recipients × 3 envs) currently `verificationStatus: NOT_SET`
- **Current state:** Channels created via Terraform; verification status never set. CRITICAL routing path uses Chat webhook (proven end-to-end at HTTP 200) so emails are belt-and-braces.
- **Future options:**
  1. Per-channel `gcloud monitoring channels verify` flow (manual code-entry per recipient).
  2. Console UI verification flow (same code-entry, different surface).
- **Triggers:** Email alerts become operationally needed (e.g., real traffic post-F-series, or operators want a parallel non-Chat path).
- **References:** `docs/deviations.md` "P0.6 Phase 8 — Email channel verification deferred", commit `bb5bf0e`.
- **Owner phase:** Operator-driven.

### 2.3 Default VPC cleanup across 5 projects

- **Item:** Delete the unused default VPCs in each GCP project (open SSH/RDP allows from 0.0.0.0/0 by default)
- **Current state:** Default VPCs exist but no Cortex resources use them. Open-internet SSH/RDP allow rules remain.
- **Future options:** Terraform-managed cleanup module that deletes default VPC + firewall rules across all 5 projects.
- **Triggers:** "Housekeeping; separate commit when convenient" — also: any external security review flagging the open default VPC firewall rules.
- **References:** `docs/progress/status.md` P0.5 deferred section; ADR-INFRA-003.
- **Owner phase:** Operator-driven, low priority.

### 2.4 VPC egress hardening

- **Item:** Replace TCP:443→0.0.0.0/0 firewall rule with IP-allowlist or egress proxy
- **Current state:** Open egress on TCP:443 (only outbound path for Anthropic, Resend, WorkOS — all dynamic-IP APIs). NAT logs every outbound, but allowlist hardening deferred.
- **Future options:**
  1. Egress proxy (Squid or similar) terminating outbound TLS, with per-destination allowlist.
  2. Per-destination static routes via Service Connect (where APIs offer it).
  3. Maintained IP allowlist updated via API (fragile — APIs publish IP ranges variably).
- **Triggers:** Compliance review flags the open egress; or a security incident driven by exfil via the path.
- **References:** ADR-INFRA-003 §Firewall posture, `infra/terraform/modules/networking/main.tf:178` (`TODO(P11.x)`).
- **Owner phase:** P11.x Display Data hardening pass, or operator-driven if earlier trigger.

### 2.5 Migrate inline `@google-cloud/*` deps to pnpm catalog

- **Item:** `@google-cloud/secret-manager` and `@google-cloud/kms` are inline-pinned in `packages/secrets/package.json`; `@google-cloud/storage` is in the pnpm-workspace catalog (newer convention, F01 Slice B). The convention drift is benign but inconsistent.
- **Current state:** Two patterns coexist — inline major-version pins (`"^5.6.0"`, `"^4.5.0"`) for older deps, `"catalog:"` refs for newer ones.
- **Future options:**
  1. Add `@google-cloud/secret-manager` and `@google-cloud/kms` to the catalog at the currently-resolved versions; flip both to `"catalog:"` in `packages/secrets/package.json`. Single source of truth across the workspace.
  2. Leave as-is permanently — pnpm doesn't enforce uniformity.
- **Triggers:** Any dependency update cycle that touches `@google-cloud/*` packages, OR a third-party @google-cloud consumer arrives in the workspace and needs version-coupling with the existing two.
- **References:** `pnpm-workspace.yaml`, `packages/secrets/package.json`, `packages/blob-storage/package.json` (catalog precedent), F01 Slice B sub-phase 7 finding.
- **Owner phase:** Operator-driven; low priority.

---

## 3. Regulatory / contractual triggers

### 3.1 HSM-backed CMEK for production keys

- **Item:** Upgrade prod CMEK keys from SOFTWARE → HSM (FIPS 140-2 Level 3)
- **Current state:** All 17 keys SOFTWARE-protection. Dev/staging will stay SOFTWARE indefinitely.
- **Future options:** Parallel HSM keyring + 5 HSM keys in prod; phased migration per resource class (Cloud SQL hardest, Pub/Sub easiest); deprecate SOFTWARE versions after 30-day overlap.
- **Triggers:**
  1. Scheduled at P11.4 (~4 weeks before Display Data go-live).
  2. Earlier if any Enterprise DPA explicitly requires FIPS 140-2 L3 (HSM-backed) key material before signing.
- **References:** ADR-INFRA-004 §Decision 3, Implementation note 5 (full migration plan).
- **Owner phase:** P11.4.

### 3.2 Org-level deny policies (`roles/iam.denyAdmin`)

- **Item:** Reintroduce env-level IAM deny policies once `roles/iam.denyAdmin` can be granted at org/folder level
- **Current state:** Phase 1 defers env-level deny policies (the role isn't grantable at project level — org/folder only); rely on implicit deny via role design.
- **Future options:** Org-level `roles/iam.denyAdmin` grant to a designated security role, then add env-scoped deny policies for sensitive operations (e.g., destroy KMS key, delete state bucket).
- **Triggers:** "Phase 2+" — when org-level coordination is feasible (typically once a security/compliance function exists in the org).
- **References:** ADR-INFRA-002 Quirk 4, `docs/progress/status.md` P0.3 deferred section.
- **Owner phase:** Phase 2+.

### 3.3 Cloud EKM (external key material)

- **Item:** Support Cloud EKM keys (key material outside GCP) for tenants with sovereign-key requirements
- **Current state:** Not evaluated for Phase 1.
- **Future options:** Configure Cloud EKM partner integration for that tenant's keys; coexists with CMEK for other tenants.
- **Triggers:** A tenant DPA explicitly requires key material held outside GCP (e.g., in their own HSM or partner HSM-as-a-service).
- **References:** ADR-INFRA-004 §Alternative 6.
- **Owner phase:** Operator-driven, ad-hoc per-tenant.

### 3.4 DPDP / SOC 2 / sectoral regulatory drift

- **Item:** Re-evaluate encryption + key-management posture against new regulations
- **Current state:** SOFTWARE Phase 1 + HSM-prod-at-P11.4 satisfies DPDP "reasonable security safeguards" + SOC 2 CC6.1.
- **Future options:** Adjust rotation cadence (90→60 or 30 days), protection level, or jurisdiction-specific key sovereignty per new mandate.
- **Triggers:** DPDP amendments, sectoral regulation (RBI, SEBI etc.), or client-jurisdiction rules (EU GDPR-specific tenant, US federal tenant).
- **References:** ADR-INFRA-004 §Revisit triggers.
- **Owner phase:** Operator-driven, regulatory-driven.

---

## 4. Phase-sequenced

### 4.1 `@cortex/observability` library (P0.6 Phase 2)

**Resolved 2026-04-25** by P0.6 Phase 2 (commit `15e5574`) — see "## Resolved deferrals" below.

### 4.2 P0.10 audit-events convention (`@cortex/audit-events`)

- **Item:** Cross-cutting library for emitting audit events to the SHA-chained `audit_event` table
- **Current state:** `audit_event` table + chain trigger exist (migration 0004). No emitter library; mutating service methods don't emit yet.
- **Future options:** Land per the build prompt §P0.10 spec.
- **Triggers:** Hard prerequisite for clean F-series audit emission; gates a CLAUDE.md convention ("every mutating service method emits an audit event").
- **References:** Build prompts §P0.10, ADR-DB-003, `docs/architecture/audit-event-convention.md` (TBD).
- **Owner phase:** P0.10 (after P0.6 Phase 2).

### 4.3 P0.8 MCP scaffolding (post-F05 per ADR-SEQ-001)

- **Item:** Three MCP servers + capability-layer packages + tool registry
- **Current state:** Stub directories at `apps/mcp-cortex-core`, `apps/mcp-edge`, `apps/mcp-admin-ops` (gitkeep only). No tool registry. No trust-model ADRs (MCP-002/003/004).
- **Future options:** Land per ADR-MCP-001 + ADR-SEQ-001.
- **Triggers:** F-series complete (F01-F05) so real tools exist to register.
- **References:** ADR-MCP-001, ADR-SEQ-001, build prompts §P0.8.
- **Owner phase:** P0.8, post-F05.

### 4.4 Trust-model ADRs (MCP-002/003/004)

- **Item:** ADRs for mcp-cortex-core, mcp-edge, mcp-admin-ops trust models
- **Current state:** Reserved IDs only; not drafted.
- **Future options:** Each fleshes out "when the first tool for each server is implemented" per ADR-MCP-001 §References.
- **Triggers:** First tool added to each server (will naturally co-occur with P0.8 since P0.8 lands the registries).
- **References:** ADR-MCP-001 §195.
- **Owner phase:** P0.8 + first-tool prompts.

### 4.5 `cortex-ci-test-shared` SA

- **Item:** Shared-project test SA for first GCP-accessing CI workflow
- **Current state:** Not provisioned. Per ADR-INFRA-006 §Decision 4, deferred until first GCP-accessing CI workflow exists.
- **Future options:** Add per the WIF substrate pattern; bind to `.github/workflows/ci.yaml@refs/heads/main` via `workload_identity_user`.
- **Triggers:** First CI workflow needs to call GCP APIs (e.g., pre-baked builder image per ADR-CI-001 Option B).
- **References:** ADR-INFRA-006 §Decision 4, ADR-CI-001.
- **Owner phase:** First GCP-accessing CI prompt.

### 4.6 `secrets.put` integration test

- **Item:** Integration test exercising real `secrets.put` against Secret Manager
- **Current state:** Unit tests pass with mocked client; integration test file exists but auto-skips put case (`put integration deferred until F02 exercises it`).
- **Future options:** Add an integration test creating + deleting a `cortex-app-test-*` secret per run, using F02-style admin credentials.
- **Triggers:** F02 implementation hits real-secret-creation paths.
- **References:** `packages/secrets/test/integration/secret-manager.integration.spec.ts`, P0.7 design lock.
- **Owner phase:** F02 (P1.2).

### 4.7 F05 → A01 Feature Store integration hook

- **Item:** When schema changes, F05 notifies A01 to trigger feature re-computation or invalidate stale features
- **Current state:** Hook stubbed in F05 build prompt scope.
- **Future options:** Full integration when A01 lands (Phase 2).
- **Triggers:** A01 Feature Store implementation phase begins.
- **References:** Build prompts §F05.
- **Owner phase:** Phase 2 (A01).

### 4.8 Express span lifetime hooks

- **Item:** Extend the observability HTTP middleware's Express adapter to end spans on actual response completion, not on `next()` return
- **Current state:** `buildObservabilityMiddleware().express` calls `next()` synchronously and resolves immediately, so `span.end()` fires before downstream handlers complete. Span timing is therefore entry-only on Express; correlation_id propagation via async-hooks is unaffected (the AsyncLocalStorage scope persists into downstream handlers regardless). The Hono adapter `await`s `next()` and times correctly.
- **Future options:** Hook `res.on('finish')` and `res.on('close')` inside the Express adapter; keep the span open until either fires, then `span.end()`.
- **Triggers:** First Express-using F-service consumes the middleware. If the F-series standardizes on Hono (per the open §10.11 question) this entry never fires.
- **References:** `packages/observability/src/http-middleware.ts:buildObservabilityMiddleware.express`, ADR-OBS-001.
- **Owner phase:** First Express consumer, or skip entirely if Hono is adopted.

### 4.9 OTel semantic-conventions naming alignment

- **Item:** Manual span attributes in the observability middlewares use legacy OTel attribute names; auto-instrumentations now emit the v1.20+ canonical names. Risk: dashboards joining manual spans + auto-instrumented spans see split keys.
- **Current state:** HTTP middleware emits `http.method` / `http.target`; gRPC middleware emits `rpc.system` / `rpc.service` / `rpc.method`; Pub/Sub wrapper emits `messaging.system` / `messaging.destination.name`. v1.20+ semantic conventions migrated HTTP attributes to `http.request.method` / `url.path` and renamed several messaging attributes.
- **Future options:** Sweep `packages/observability/src/{http-middleware,grpc-middleware,pubsub-wrapper}.ts` to emit v1.20+ names; consider dual-emission during a deprecation window if dashboards already exist.
- **Triggers:** Any of (a) F-series dashboard work surfaces split-key confusion; (b) `@opentelemetry/auto-instrumentations-node` upgrade where the legacy names stop being emitted entirely; (c) ADR-OBS-002 (Cloud Run metric export, drafted post-deploy) calls out the inconsistency.
- **References:** `packages/observability/src/http-middleware.ts`, `packages/observability/src/grpc-middleware.ts`, `packages/observability/src/pubsub-wrapper.ts`, https://opentelemetry.io/docs/specs/semconv/.
- **Owner phase:** Follow-up sweep after F01 dashboards land.

### 4.10 Subpath exports for test utilities (precedent)

- **Item:** Convention for exposing test-only helpers from a workspace package without polluting the production import surface
- **Current state:** `@cortex/observability/test-utils` subpath established in P0.6 Phase 2 (commit pending). `LogCapture` lives at `packages/observability/src/test-utils.ts`; package.json declares the subpath via `exports`. Production imports go through the default barrel; tests in other packages import via the subpath. Avoids deep-relative imports across package boundaries.
- **Future options:** Apply the same pattern to any future package whose test consumers need shared helpers — most immediately `@cortex/auth/test-utils` when AC01 lands and downstream services need to mock auth context.
- **Triggers:** AC01 implementation, or any future package where tests in _other_ packages need a helper.
- **References:** `packages/observability/package.json` (`exports` map), `packages/observability/src/test-utils.ts`, P0.6 Phase 2.
- **Owner phase:** AC01 (P2.1) and any subsequent package with cross-package test-helper needs.

### 4.11 `audit_event` indexes for SCR-22 elevated-review queries

- **Item:** Indexes on `audit_event` to support SCR-22 Compliance Operations elevated-review filters (per spec SCR-20-FR-012)
- **Current state:** Migration 0004 ships a single index `audit_event_tenant_time` on `(tenant_id, occurred_at DESC, event_id)` — sufficient for "recent events for tenant" lookups. SCR-22 queries (permission grants to high-privilege roles, cross-tenant access flagged by SCR-24, consent withdrawals not followed by successful cascade, large export operations, audit-source disable events) need additional indexes whose shape depends on the actual filter set. Migration 0008 (P0.10) deliberately does NOT add indexes — single-purpose CHECK extension only.
- **Future options:** Composite indexes on `(action, tenant_id, occurred_at)` for action-scoped scans; partial indexes `WHERE action IN (...)` for the elevated-review category list; expression indexes on `payload->>'severity'` for severity-flagged scans; `action_verb` column promotion (per ADR-AU-001 Consequences) plus index. Choice depends on which SCR-22 filter combinations dominate.
- **Triggers:** SCR-22 build prompt active OR query observability shows sequential scans of `audit_event` with `tenant_id` filter alone exceeding ~100ms P95.
- **References:** Cortex v2.2 Spec §SCR-20-FR-012, §SCR-22, ADR-DB-003, ADR-AU-001 Consequences (verb-query CASE), migration `services/foundation/migrations/0004_audit_chain.sql`, `docs/planning/p0-10-audit-events-scope.md` Decision 6 / Sub-phase 2.
- **Owner phase:** SCR-22 (Phase 2+).

### 4.12 Pub/Sub fan-out for downstream audit consumers

- **Item:** Read-only async fan-out from `audit_event` to Pub/Sub for analytics / SIEM / BigQuery consumers
- **Current state:** P0.10 ships direct DB INSERT only (per ADR-AU-001 Decision). No async fan-out — real-time analytics and SIEM consumers cannot subscribe to audit events. The synchronous DB write is the source of truth and remains the chain of custody.
- **Future options:** (a) Postgres LISTEN/NOTIFY trigger publishing to Pub/Sub; (b) Logical-decoding consumer (Debezium-style) reading WAL and publishing; (c) Scheduled batch export from `audit_event` to BigQuery (lower latency cost). All paths are READ-ONLY relative to `audit_event` — they republish committed rows; they do not write back. This is critical for chain integrity.
- **Triggers:** First non-DB consumer materializes — likely SCR-20 dashboard real-time view, A07 BigQuery Decision Log mirror, or a Phase 5 SIEM integration. Pick the path based on consumer's latency needs and write-volume.
- **References:** ADR-AU-001 Decision (direct INSERT) + Alternatives considered (Pub/Sub-only, dual-write, LISTEN/NOTIFY); P0.10 planning doc Decision 1; spec SCR-20-FR-002 (event coverage), A07-FR-002 (BigQuery Decision Log, 7-year retention), O04-FR-009 (Action Audit Log, 7-year retention).
- **Owner phase:** First non-DB consumer (SCR-20 / A07 / SIEM).

### 4.13 Decouple `@cortex/observability`'s `defaultContextProvider` from `@cortex/tenant-context`

- **Item:** Remove the `getTenantId` import from `@cortex/observability/src/context-provider.ts` and the `@cortex/tenant-context` workspace dep, leaving observability with `stubContextProvider` semantics by default
- **Current state:** `defaultContextProvider` imports `getTenantId` from `@cortex/tenant-context` at module-load time. This created a load-order cycle once `@cortex/tenant-context` began consuming `@cortex/audit-events` in P0.10 sub-phase 7: `tenant-context → audit-events → observability → tenant-context`. The cycle is currently broken on the `audit-events → observability` edge — `audit-events/src/emit.ts` imports `Logger` type-only and resolves `createLogger` via dynamic `await import('@cortex/observability')` on first WARN emission. F01 Slice B sub-phase 2 expanded the cycle topology by introducing a second triangle: `observability → tenant-context → secrets → observability` (closed because `secrets/src/audit.ts` instantiates a logger at top-level via `createLogger`). The same dynamic-import pattern resolves it — `tenant-context/src/tenants.ts:create()` imports `buildKeyResourceName` from `@cortex/secrets` lazily on first call. Works but indirect; the architecturally cleaner fix is to remove the reverse-direction observability → tenant-context edge entirely.
- **Future options:** (a) Rewrite `defaultContextProvider` to stub `getTenantId` (observability has zero dep on tenant-context); ship a `tenantContextProvider` from `@cortex/tenant-context` that callers spread into their own provider when they want tenant-id auto-injection. (b) Introduce a thin bridge package (`@cortex/observability-tenant-bridge`) that owns the wiring, so neither end has the edge. (c) Late-binding via a setter (`registerTenantIdSource(fn)`) called by tenant-context at its own init — runtime side effect, but breaks the static import.
- **Triggers:** First time someone refactors observability and trips on the cycle, OR a future cross-package test fails because of it. The dynamic-import workaround is fragile to removal of `await import()` — any consumer who tries to make `createAuditEventEmitter` or `tenants.create` synchronous-only would re-introduce the cycle. **Each new package that consumes observability AND is consumed by tenant-context (directly or transitively) re-asserts a fresh cycle edge; F02's per-tenant key creation path is likely to add another.**
- **References:** `packages/observability/src/context-provider.ts` (the offending import), `packages/audit-events/src/emit.ts` (Decision 11 cycle break), `packages/tenant-context/src/tenants.ts` (Slice B sub-phase 2 cycle break in `create()`), P0.10 sub-phase 7 finding, F01 Slice B sub-phase 2 finding.
- **Owner phase:** First observability refactor, or first cross-package test that surfaces a cycle regression.

### 4.14 AC01 swap of hardcoded service actor in `@cortex/encryption`

- **Item:** Replace the hardcoded `actorId='cortex-encryption'` (with `actorType='service'`) on `PII_ENCRYPTED` / `PII_DECRYPTED` audit emissions with a request-scoped actor resolved from async-local context.
- **Current state:** `encryptForTenant` and `decryptForTenant` emit `audit_event` rows with `actorType='service'`, `actorId='cortex-encryption'`. Useful for "which subsystem touched this PII" forensics; less useful for "which user triggered the encryption" attribution. The higher-level audit (e.g., `TENANT_UPDATED` from a request handler) carries user-attribution today; encryption-layer events do not.
- **Future options:**
  1. Add an optional `actor` field to `EncryptParams` / `DecryptParams`; explicit caller supply.
  2. Wire AC01's request-scoped actor resolver via async-local — encryption library reads from the store on each emit.
  3. Both — caller-supplied wins; async-local fallback when not provided.
- **Triggers:** AC01 (P2.1) ships its actor resolver.
- **References:** `packages/encryption/src/encrypt.ts` (the hardcoded site), F01 Slice B sub-phase 4 finding, `docs/architecture/encryption-blob-storage-convention.md` "Audit emission for encryption operations".
- **Owner phase:** AC01 (P2.1).

### 4.15 Redundant `getKeyForTenant` consult in `@cortex/encryption`

- **Item:** `encryptForTenant` calls `getKeyForTenant(tenantId)` explicitly to populate the audit event's `key_resource_name` field, AND `envelope.encrypt` calls `buildKeyResourceName('cortex-general-key')` internally — two lookups per encrypt op. Each `getKeyForTenant` call also emits a `[SECRETS-AUDIT]` operational pino log, doubling the operational log volume per encrypt.
- **Current state:** Redundant in Phase 1 (both deterministic to the same env key). When F02 swaps `getKeyForTenant` to query `tenant_kms_key` per tenant, the redundancy becomes more visible (per-tenant lookup latency × 2).
- **Future options:**
  1. `envelope.encrypt` accepts a pre-resolved `keyResourceName`; `@cortex/encryption` resolves once and threads it through.
  2. `envelope.encrypt` returns the resolved key in its result tuple; `@cortex/encryption` reads from the result.
  3. Merge the lookup paths in F02 alongside the resolver swap.
- **Triggers:** F02 (P1.2) swaps `getKeyForTenant` to per-tenant resolution.
- **References:** `packages/encryption/src/encrypt.ts` (the duplicate consult), `packages/secrets/src/kms.ts` (the internal call site), F01 Slice B sub-phase 4 finding.
- **Owner phase:** F02 (P1.2).

### 4.16 Logger plumbing in `@cortex/quotas` is dead code

- **Item:** `@cortex/quotas` declares the `@cortex/observability` cycle-break shape (type-only `Logger` import + dynamic `await import('@cortex/observability')` resolution per CLAUDE.md "P0.10+ — library-driven emission") but emits zero operational log lines today. The wiring is present in the package's import graph but no call site uses it.
- **Current state:** `audit-events` cycle-break pattern was reproduced in `@cortex/quotas` for symmetry with `@cortex/tenant-context` so a future log site doesn't need to re-think load-order. No log lines emit today; check-quota emissions go to `audit_event` only.
- **Future options:**
  1. First operational log site lands (e.g., a debug log when an upsert hits the unique-constraint retry path) → exercise the dynamic-import path; verify it doesn't re-introduce the load-order cycle.
  2. Drop the dynamic-import wiring entirely if it remains unused at F02 ship — the symmetry argument weakens once F02-era observability requirements are concrete.
  3. Promote it to a real `info`-level emission point (e.g., one log line per quota refill window-rollover) for FinOps visibility.
- **Triggers:** First feature in `@cortex/quotas` that wants a structured log line, OR F02 ship time (decide-or-delete).
- **References:** `packages/quotas/src/check-quota.ts` (where the type-only import lives but is unused), CLAUDE.md "P0.10+ — library-driven emission" subsection on the cycle-break gotcha.
- **Owner phase:** F02 (P1.2) or first quotas-internal logging requirement.

### 4.17 Retire `f02-swap-paths-for-slice-c-resolvers.md` doc

- **Item:** `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md` (~194 lines, authored 2026-04-26) catalogs the two Phase 1 stub resolvers shipped by Slice C (`getQuotaConfig`, `getComputePlacement`) and their planned F02 evolution path. The doc serves as a contract between Slice C and F02's tenant-lifecycle work; once F02 swaps both resolvers to their real implementations, the doc's purpose is exhausted.
- **Current state:** Active. Slice C-era doc; cited from ADR-COMPUTE-001 §5, the convention doc, and the planning doc.
- **Future options:**
  1. Retire the doc when F02 ships both resolver swaps — replace with a one-line "see ADR-COMPUTE-001 §5 (Resolved)" pointer in any docs that referenced it.
  2. Keep it as a historical record in `docs/archive/` if the swap journey provides reusable lessons (e.g., the substrate-now / real-impl-later pattern's evolution).
  3. Refactor in place if F02 partial-swaps (only one of the two resolvers): keep the unswapped resolver section, mark the other as Resolved with a commit-hash backfill.
- **Triggers:** F02 ships the swap of both resolvers (per the doc's "Migration steps" sections).
- **References:** `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md`; ADR-COMPUTE-001 §5; ADR-INFRA-007 (precedent: KMS-key substrate-now / real-impl-later doc has a similar lifecycle).
- **Owner phase:** F02 (P1.2).

---

## 5. First-consumer-driven

### 5.1 Bi-temporal helper functions

- **Item:** `as_of_known` (system-time view), `point_in_time_join`, `temporal_union`, `temporal_intersection`
- **Current state:** Not implemented. Per ADR-DB-001 §Implementation Notes, "deferred to first consumer." The predicate `at_time_t` + SCD trigger in 0002 is the minimum infrastructure.
- **Future options:** Per-table SQL views (`as_of_known`), or `EXECUTE format(...)` helpers in `cortex` schema.
- **Triggers:** First consumer arrives. `point_in_time_join` is for A01 Feature Store (P4.x); the others land when an analytical screen needs them.
- **References:** ADR-DB-001 §Implementation Notes Decision 8, F03 build prompt.
- **Owner phase:** First-consumer-driven.

### 5.2 Per-table `as_of_valid` wrappers

- **Item:** One-line per-table function over `at_time_t` for ergonomic as-of queries
- **Current state:** Pattern documented in ADR-DB-001 §Implementation Notes; no actual wrapper exists yet.
- **Future options:** Add as each F-/D-series bi-temporal table is created.
- **Triggers:** Each new bi-temporal table in F-series / D-series.
- **References:** ADR-DB-001 §Implementation Notes.
- **Owner phase:** F01-F05, D01.

### 5.3 `verify_chain` audit chain integrity verifier

- **Item:** Function or service that walks a tenant's audit chain and returns chain-integrity status
- **Current state:** Not implemented. Hash chain lands per row; no cumulative verifier.
- **Future options:** PL/pgSQL function `cortex.verify_chain(tenant_id)` returning (last_verified_event_id, status, divergence_point).
- **Triggers:** SCR-20 (Audit Log UI, P8.12) needs to surface chain integrity status.
- **References:** ADR-DB-003 §Implementation Notes.
- **Owner phase:** P8.12 (SCR-20).

### 5.4 `cortex_admin` Postgres role + admin-bypass policies

- **Item:** Role with `BYPASSRLS` + admin-bypass RLS policies for admin tooling
- **Current state:** Not implemented. ADR-DB-002 §Decision 4 explicitly defers ("premature; SCR-20 is the natural trigger").
- **Future options:** Create `cortex_admin` role; add `admin_read_policy` template alongside the per-table tenant policies; admin tools connect as `cortex_admin`.
- **Triggers:** SCR-20 (P8.12) needs cross-tenant audit-log read.
- **References:** ADR-DB-002 §Decision 4 + §Reasoning.
- **Owner phase:** P8.12 (SCR-20).

### 5.5 Configuration-as-Code Git sync (F04)

- **Item:** Bidirectional YAML export/import for tenant configurations
- **Current state:** API stubbed in F04 scope; no actual Git sync.
- **Future options:** Push tenant configs to per-tenant Git repos; webhook-driven sync on commit.
- **Triggers:** "Enterprise only, deferred to Phase 2" per F04 build prompt §4.
- **References:** Build prompts §F04 §4.
- **Owner phase:** Phase 2.

### 5.6 `Equals<X, Y>` compile-time type-witness helper extraction

- **Item:** A two-line conditional-type helper (`type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false`) used to assert at type-check time that two type expressions are structurally identical. Slice C's compute-placement test suite uses it to lock down the `ComputePlacement` discriminated-union shape against accidental drift.
- **Current state:** Inline in `packages/compute-placement/test/types.spec.ts` only. One consumer; the helper is short enough that duplicating it in a second consumer is the conventional second-step before extraction.
- **Future options:**
  1. Extract to a shared `@cortex/test-utils` (or `@cortex/internal-types`) package once a second consumer needs it. Export as `assertTypeEquals<X, Y>` to keep the call-site readable.
  2. Inline-and-duplicate at each consumer (current). Acceptable for ≤3 consumers given the helper is two lines.
  3. Ship as a TS-internal-only package (no JS emit) so it stays a type-system concern.
- **Triggers:** Second consumer wants the same compile-time witness — probably `@cortex/quotas` `CheckQuotaResult` discriminated-union assertion in F02-era refactors, or any other library shipping a public discriminated-union surface.
- **References:** `packages/compute-placement/test/types.spec.ts` (current sole site).
- **Owner phase:** First-consumer-driven (N≥2 trigger).

---

## 6. Phase 1 explicit cuts

### 6.1 SCR-24 Platform Ops Dashboard

- **Item:** Full Platform Ops capability (cross-env, cross-tenant operator dashboards)
- **Current state:** Phase 1 minimal cut shipped: provisioning wizard only.
- **Future options:** Full capability per spec §SCR-24 (Phase 2).
- **Triggers:** Phase 2 backend modules complete; operator load justifies a unified dashboard.
- **References:** Build prompts §P8.13.
- **Owner phase:** Phase 2.

### 6.2 OB02 FinOps & Cost Management

- **Item:** Per-tenant cost attribution + budget alerts + chargeback
- **Current state:** Stub for Phase 1 (ADR-OBS-001 §Decision 4 mentions "OB02" as Phase 5).
- **Future options:** Full implementation per spec §OB02 (Phase 5).
- **Triggers:** Multi-tenant production traffic + revenue requiring chargeback.
- **References:** Build prompts §P5.10, ADR-OBS-001.
- **Owner phase:** Phase 5 (P5.10).

### 6.3 OB03 Metering & Billing

- **Item:** Per-tenant usage metering + invoice generation
- **Current state:** Stub for Phase 1.
- **Future options:** Full implementation per spec §OB03 (Phase 5).
- **Triggers:** Paid tenants exist + billing automation needed.
- **References:** Build prompts §P5.11.
- **Owner phase:** Phase 5 (P5.11).

### 6.4 I03 Multi-Source Conflict Resolution

- **Item:** Resolving conflicting attribute values across multiple ingestion sources
- **Current state:** Deferred to Phase 2 in v2 build prompts.
- **Future options:** Implement per spec §I03 when Body Shop (or similar conflict-heavy use case) drives demand.
- **Triggers:** "Body Shop drives demand" per build_prompts; or any tenant where multiple sources for the same entity start producing meaningful conflicts.
- **References:** Build prompts §P4.3, status.md.
- **Owner phase:** Phase 2.

### 6.5 I02 Knowledge Graph full graph DB

- **Item:** Migrate from Postgres recursive CTEs to a dedicated graph DB
- **Current state:** Phase 1 cut uses Postgres recursive CTEs only.
- **Future options:** Neo4j, ArangoDB, or pgvector-adjacent extensions for graph workloads.
- **Triggers:** Recursive CTE query performance crosses unacceptable threshold; or graph workloads (multi-hop, pathfinding) become primary use cases.
- **References:** Build prompts pre-flight architectural decisions.
- **Owner phase:** Phase 3.

### 6.6 ED01 Edge-Cloud Orchestrator

- **Item:** Edge device runtime + cloud orchestration plane
- **Current state:** Deferred. No edge devices in Display Data Phase 1.
- **Future options:** Implement per spec §ED01 when edge-device tenants land.
- **Triggers:** First tenant with deployed edge devices (e.g., HHT app expanding into edge inference).
- **References:** Build prompts pre-flight architectural decisions.
- **Owner phase:** Phase 2.

### 6.7 Mobile UX (375-767px)

- **Item:** Phone-form-factor responsive design for admin + analytical screens
- **Current state:** Phase 1 = tablet 768px+. Phone view not implemented.
- **Future options:** Tailwind responsive variants + design tokens for the 375-767 range.
- **Triggers:** First customer demanding mobile use, or Phase 2 timeline.
- **References:** Build prompts pre-flight architectural decisions.
- **Owner phase:** Phase 2.

### 6.8 Dashboard Builder UI

- **Item:** Tenant-facing UI for assembling custom dashboards
- **Current state:** Parked. Sevyn8 authors all dashboards in Phase 1-2.
- **Future options:** Drag-and-drop dashboard builder consuming the widget library.
- **Triggers:** Customer demand for self-service dashboarding.
- **References:** Build prompts pre-flight architectural decisions.
- **Owner phase:** Phase 3.

### 6.9 Workspace aggregate rollup

- **Item:** Tenant-Admin aggregate view rolling up data across workspaces (for billing/ops)
- **Current state:** Strict workspace-level data isolation. No rollup.
- **Future options:** Materialized aggregates per tenant scoped above workspace boundary, with explicit access control.
- **Triggers:** Enterprise tenant with many workspaces needs unified billing/ops view.
- **References:** Build prompts pre-flight architectural decisions.
- **Owner phase:** Phase 2.

---

## 7. Stub implementations

### 7.1 `getKeyForTenant` Phase 1 stub

- **Item:** Per-tenant KMS key resolver
- **Current state:** Returns env's `cortex-general-key` regardless of `tenantId`. Audit-logs as if it were tenant-scoped. Fully type-safe interface ready for swap.
- **Future options:** F02 swap reads from `tenant_kms_key` control-plane table populated at tenant provisioning.
- **Triggers:** F02 (P1.2) provisioning pipeline lands per-tenant key creation.
- **References:** `packages/secrets/src/per-tenant-keys.ts`, ADR-INFRA-004 §Decision 5.
- **Owner phase:** F02.

### 7.2 `bootstrap_admin` table

- **Item:** Pre-AC01 super-admin placeholder row
- **Current state:** Migration 0005 creates the table; P0.9 CLI populates rows in dev/staging. `password_secret_ref` points to Secret Manager version.
- **Future options:** AC01 (P2.1) ships a one-shot promotion migration that reads `bootstrap_admin` rows where `promoted_to_users = false`, hashes the password with argon2id, writes to `users` + `user_role_assignment(SUPER_ADMIN)`, marks `promoted_to_users = true` + `promoted_at = now()`.
- **Triggers:** AC01 implementation phase.
- **References:** `services/foundation/migrations/0005_bootstrap_admin.sql`, `docs/runbooks/super-admin-bootstrap.md`, P0.9 commit `51253c7`.
- **Owner phase:** AC01 (P2.1).

### 7.3 ContextProvider stub provider

- **Item:** Interface for tenant_id/user_id/request_id context propagation
- **Current state:** Per ADR-OBS-001 §Decision 2, the interface is defined; the stub provider returns undefined for tenant/user. Library is usable today; logs degrade gracefully.
- **Future options:** F01 satisfies tenant_id; AC01 satisfies user_id. No retrofit — middleware just implements the interface.
- **Triggers:** F01 (P1.1) middleware lands; AC01 (P2.1) auth middleware lands.
- **References:** ADR-OBS-001 §Decision 2.
- **Owner phase:** F01 + AC01.

### 7.4 `app.tenant_id` session variable contract

**Resolved 2026-04-25** by F01 Slice A (commit `4811821`) — see "## Resolved deferrals" below.

### 7.5 RLS FORCE flag (test-only)

**Resolved 2026-04-25** by F01 Slice A (commit `4811821`) — see "## Resolved deferrals" below.

---

## 8. Code TODOs tied to future phases

### 8.1 `[SECRETS-AUDIT]` swap

**Resolved 2026-04-25** by P0.6 Phase 2 (commit `15e5574`) — see "## Resolved deferrals" below.

### 8.2 `[BOOTSTRAP-AUDIT]` swap

**Resolved 2026-04-25** by P0.6 Phase 2 (commit `15e5574`) — see "## Resolved deferrals" below.

### 8.3 VPC egress hardening marker

- **Item:** TCP:443→0.0.0.0/0 firewall rule replacement
- **Current state:** Open egress on TCP:443 with `TODO(P11.x)` comment listing hardening options.
- **Future options:** See entry 2.4 above.
- **Triggers:** P11.x Display Data hardening pass.
- **References:** `infra/terraform/modules/networking/main.tf:178`, ADR-INFRA-003 §Firewall posture.
- **Owner phase:** P11.x.

---

## 9. Specification deviations

These mirror entries in `docs/deviations.md`; listed here for forward-planning visibility.

### 9.1 Compute plane: GKE Prometheus → Cloud Run + OTLP

- **Item:** Build prompt assumed GKE Prometheus scraping; Cortex compute is Cloud Run.
- **Current state:** OTLP export via OpenTelemetry SDK (per ADR-OBS-001 §Decision 1).
- **Future options:** Continue OTLP path; revisit only if compute plane changes.
- **Triggers:** Compute-plane migration (none planned).
- **References:** `docs/deviations.md` row 1, ADR-OBS-001 §Decision 1, ADR-OBS-002 (forthcoming).
- **Owner phase:** Resolved in P0.6.

### 9.2 PII redaction in logs

- **Item:** Build prompt omitted; spec OB01-FR-002 mandated.
- **Current state:** Scope-in to P0.6 library (Phase 2). Substrate-level redaction.
- **Future options:** Pino redaction middleware + allowlist/denylist config.
- **Triggers:** P0.6 Phase 2 library lands.
- **References:** `docs/deviations.md` row 2, ADR-OBS-001 §Decision 5, ADR-OBS-003 (forthcoming).
- **Owner phase:** P0.6 Phase 2.

### 9.3 Alert routing: O02 → email + Chat direct

- **Item:** Spec OB01-FR-004 routed alerts through O02; O02 is Phase 5.
- **Current state:** Email + Chat direct via Cloud Monitoring notification channels.
- **Future options:** Retarget to O02 when it lands (~30 min config change per ADR-OBS-001 §Decision 4).
- **Triggers:** O02 (P5.7) lands.
- **References:** `docs/deviations.md` row 3, ADR-OBS-001 §Decision 4.
- **Owner phase:** P5.7.

### 9.4 P0.6 scope boundary

- **Item:** Build prompt scoped library only; we shipped library + operator infrastructure + dashboards.
- **Current state:** Phase 1 + Phase 8 done; Phase 2 library pending; Phase 3 dashboards deferred indefinitely.
- **Future options:** Per ADR-OBS-001 §Decision 3 sequencing.
- **Triggers:** N/A — scope decision.
- **References:** `docs/deviations.md` row 4, ADR-OBS-001 §Decision 3.
- **Owner phase:** Resolved in P0.6.

### 9.5 Tenant-scoping of metrics

- **Item:** Spec required all metrics tenant-scoped; infrastructure metrics from GCP can't be tenant-tagged at ingestion.
- **Current state:** Application-emitted metrics tenant-tagged via OpenTelemetry; infrastructure metrics infrastructure-scoped.
- **Future options:** See entry 1.6.
- **Triggers:** Multi-tenant traffic inflection.
- **References:** `docs/deviations.md` row 5, ADR-OBS-001 §Decision 6.
- **Owner phase:** Operator-driven post-multi-tenancy.

### 9.6 ContextProvider source

- **Item:** Build prompt assumed F01/AC01 middleware exists; both deferred when P0.6 Phase 2 library design landed.
- **Current state:** Interface defined in P0.6 design; stub provider; F01/AC01 satisfy when they land.
- **Future options:** F01 + AC01 implement the interface.
- **Triggers:** F01 (P1.1) + AC01 (P2.1).
- **References:** `docs/deviations.md` row 6, ADR-OBS-001 §Decision 2.
- **Owner phase:** F01 + AC01.

### 9.7 F01 compute isolation: K8s namespace vs Cloud Run

**Resolved 2026-04-26** by F01 Slice C (commit `dcc503c`) — see "## Resolved deferrals" below.

### 9.8 Request id field name: `request_id` → `correlation_id`

- **Item:** Build prompt §P0.6 specifies `request_id` as the canonical per-request correlation field; observability shipped with `correlation_id`.
- **Current state:** `correlation_id` everywhere — `ContextProvider` interface, log line field, OTel span attribute (`cortex.correlation_id`), HTTP header (`x-correlation-id` with `x-request-id` as a fallback extractor), `withCorrelationContext` AsyncLocalStorage key, gRPC / Pub/Sub propagation. Mirrored in `docs/deviations.md` "P0.6 / Request-id field name".
- **Future options:** Stay on `correlation_id` (current). Alignment with broader observability convention is the upside; cost of swap is now non-trivial (consumers exist).
- **Triggers:** Spec v2.3 update consistency check; or external partner integration that mandates the prompt's name.
- **References:** ADR-OBS-001 §Decision 2, `packages/observability/src/correlation-context.ts`, `packages/observability/src/http-middleware.ts` (CORRELATION_HEADER + REQUEST_ID_HEADER fallback).
- **Owner phase:** Spec reconciliation; not action-required absent external trigger.

---

## 10. Decisions yet to be made

### 10.1 Control-plane database location

**Resolved 2026-04-25** by F01 Slice A (commit `4811821`) — see "## Resolved deferrals" below.

### 10.2 Tenant ID format

- **Item:** UUID v4 vs ULID vs human-readable slug for `tenant_id`
- **Current state:** Not decided. RLS contract uses `uuid` type; existing test fixtures use `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` style v4 UUIDs.
- **Future options:**
  1. UUID v4 (current de-facto). 36 chars, opaque, sortable randomly.
  2. ULID (lexicographic time-sortable). Useful if tenant tables become append-heavy.
  3. Human-readable slug + UUID (e.g., `acme-corp-a1b2c3d4`). Operator-friendly but harder to enforce uniqueness.
- **Triggers:** F01 (P1.1) tenant table creation.
- **References:** ADR-DB-002 (assumes UUID).
- **Owner phase:** F01.

### 10.3 Tenant tier discriminator

**Resolved 2026-04-26** by F01 Slice A (substrate) + Slice C (consumer; commit `dcc503c`) — see "## Resolved deferrals" below.

### 10.4 DB client abstraction shape

- **Item:** Per F01 §2 "abstraction layer: services never know which mode a tenant is in — the DB client picks the right instance based on tenant tier"
- **Current state:** `packages/canonical-schema/src/db-client.ts` has a thin `createDrizzleClient(pool, schema?)` factory. No tier-aware routing.
- **Slice C addendum (2026-04-26):** Slice C designs the F02 consumer (compute-placement reads `tenant.tier` to branch shared vs dedicated; see `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md` Resolver 2) but does not ship the tier-aware DB client itself. The Phase 1 stub `getComputePlacement(params)` returns shared unconditionally and accepts no `db` context; F02 will pass an explicit `db` parameter. Whether that resolves to a single shared instance or per-Enterprise dedicated instance remains §10.4's open question.
- **Future options:**
  1. F01 ships a `getTenantDbClient(tenantId)` that resolves to shared or dedicated based on tier.
  2. Per-tenant connection pool registry warmed on tenant provisioning.
  3. Multiple Drizzle clients pooled and selected at request time.
- **Triggers:** F01 (P1.1).
- **References:** Build prompts §F01 §2; `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md`.
- **Owner phase:** F01.

### 10.5 Quota enforcement implementation

**Resolved 2026-04-26** by F01 Slice C (commit `dcc503c`) — see "## Resolved deferrals" below.

### 10.6 Async-local context propagation library

**Resolved 2026-04-25** by F01 Slice A (commit `4811821`) — see "## Resolved deferrals" below.

### 10.7 Blob isolation IAM strategy

- **Item:** GCS bucket(s) layout for tenant blob isolation
- **Current state:** Not provisioned. F01 prompt §5 specifies tenant-prefixed paths.
- **Future options:**
  1. One bucket per env, tenant prefix in object path. WIF-based per-SA prefix scoping.
  2. One bucket per tenant. Cleanest isolation, more buckets to manage.
  3. One bucket per (env, tier) — Standard tenants share, Enterprise gets dedicated.
- **Triggers:** F01 (P1.1).
- **References:** Build prompts §F01 §5.
- **Owner phase:** F01.

### 10.8 Pre-signed URL signing identity

- **Item:** Which SA signs GCS pre-signed URLs that embed tenant scope?
- **Current state:** Not provisioned.
- **Future options:**
  1. Per-tenant SA (clean blast radius; many SAs).
  2. Single per-env SA with pre-signed URLs that include explicit object path constraints.
  3. Workload identity tokens with scoped audiences.
- **Triggers:** F01 (P1.1).
- **References:** Build prompts §F01 §5.
- **Owner phase:** F01.

### 10.9 OPA vs Cedar for ABAC policy language

- **Item:** Which declarative policy language for AC01's attribute-based policies
- **Current state:** Build prompt says "OPA or Cedar — evaluate both in an ADR"
- **Future options:**
  1. OPA (Rego). Mature ecosystem, widely adopted, slower than native code.
  2. Cedar (AWS-originated, declarative). Newer, designed for fast evaluation, less ecosystem.
  3. Custom DSL. Avoid — reinventing the wheel.
- **Triggers:** AC01 (P2.1) design phase.
- **References:** Build prompts §AC01 §2.
- **Owner phase:** AC01.

### 10.10 Workspaces vs hierarchies separation

- **Item:** F01 mentions workspaces (per F02); AC02 has a separate "hierarchy" concept. How do they interact?
- **Current state:** Not designed. Both are Phase 1 concerns but the boundary isn't sharp.
- **Future options:**
  1. Workspaces are the strict isolation boundary; hierarchies are policy-scope-only on top.
  2. Hierarchies subsume workspaces (single tree, with workspace as a hierarchy level).
  3. Distinct dimensions, both first-class.
- **Triggers:** F01 (P1.1) tenant model + AC02 (P2.2) hierarchy implementation.
- **References:** Build prompts §F01, §AC02.
- **Owner phase:** F01 + AC02 jointly.

### 10.11 HTTP framework choice for tenant middleware

- **Item:** Which HTTP framework does `@cortex/tenant-context.buildTenantContextMiddleware` commit to?
- **Current state:** Framework-agnostic adapter pattern in `@cortex/tenant-context`. Hono + Express adapters provided as primitives sharing a common extraction + validation core. No production consumer yet.
- **Future options:**
  1. Commit to Hono ecosystem-wide (Cloud Run-friendly, modern, fetch-API-native).
  2. Commit to Express (incumbent Node ecosystem, mature middleware library).
  3. Commit to Fastify (performance-oriented, schema-first).
  4. Keep framework-agnostic permanently — add adapters as new frameworks land.
- **Triggers:** First F-service shipping an HTTP API.
- **References:** `packages/tenant-context/src/middleware.ts`; F-series build prompts P1.2–P1.5.
- **Owner phase:** F02 or first HTTP-exposing F-service.

### 10.12 Tenant CRUD authorization layer

- **Item:** Who is allowed to call `tenants.*` (especially `tenants.list`)?
- **Current state:** Phase 1: no authz at the package layer. Anything that imports `@cortex/tenant-context` can call any method. Callers must be trusted control-plane code.
- **Future options:**
  1. AC01 layers authz: a separate `authz` package gates `tenant.list`, `tenant.create`, etc. via per-method permissions.
  2. Move CRUD behind a privileged-only HTTP surface that auths callers explicitly.
  3. Both — package-layer permission checks AND HTTP-surface auth.
- **Triggers:** AC01 design phase, or first multi-actor consumer of tenants.\* (whichever first).
- **References:** `packages/tenant-context/src/tenants.ts`; F01 deviations Issue 6.
- **Owner phase:** AC01.

### 10.13 Cursor pagination for `tenants.list`

- **Item:** Slice A uses limit/offset pagination. When does cursor pagination become necessary?
- **Current state:** `tenants.list` returns `{ items, total, limit, offset }` via `OFFSET / LIMIT`. Phase 1 has 1 tenant; predictable page-N-of-M semantics matter more than streaming for admin tooling.
- **Future options:**
  1. Switch to keyset cursor (e.g., `(created_at, id)` ordering).
  2. Hybrid: keep offset for admin UI, expose cursor for programmatic high-volume callers.
  3. Stay on offset permanently — tenant counts likely never exceed thousands.
- **Triggers:** Tenant count or query latency exceeds the offset-friendly threshold (~10k rows or noticeable p99 regression).
- **References:** `packages/tenant-context/src/tenants.ts`.
- **Owner phase:** F01 (later slice) or F02.

### 10.14 `external_id` format policy

- **Item:** Lockdown rules for tenant `external_id` values.
- **Current state:** Regex `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`, length 2..64. Lowercase slug, hyphens allowed but not at start/end.
- **Future options:**
  1. Reserve prefixes (e.g., `cortex-`, `internal-`, `system-`) for platform-owned tenants.
  2. Forbid consecutive hyphens explicitly (regex is currently permissive).
  3. Allow underscores and/or digits as the first char.
  4. Tighten length (e.g., 3..32) once the bootstrap tenant naming convention settles.
- **Triggers:** First operator collision or naming-convention clash.
- **References:** `packages/tenant-context/src/tenants.ts`; migration 0007 (`tenant.external_id`).
- **Owner phase:** F01 or F02 (operator-driven).

### 10.15 FOR UPDATE contention test for `tenants.update` / `tenants.setStatus`

- **Item:** Concurrent update test proving `SELECT ... FOR UPDATE` actually serializes contending transactions on the same tenant row.
- **Current state:** All `update` / `setStatus` tests exercise the `.for('update')` SQL syntax. Contention behavior is unverified — the Postgres lock semantics are correct by language spec, but a regression in our query construction could silently lose the lock.
- **Future options:**
  1. Add a two-connection contention test using promise barriers to force interleaving.
  2. Rely on Postgres correctness; defer permanently.
  3. Add a chaos test in the integration suite (separate from unit-spec scope).
- **Triggers:** First production-level concurrency incident, OR if any future Slice C work refactors the locking strategy.
- **References:** `packages/tenant-context/test/tenants.spec.ts`; `tenants.ts:443-489` (`setStatus`), `:341-401` (`update`).
- **Owner phase:** F02 or first concurrency incident.

---

## Resolved deferrals

### 7.4 `app.tenant_id` session variable contract — Resolved 2026-04-25 / commit `4811821`

- **Item:** Postgres session var that RLS policies read via `cortex.current_tenant_id()`
- **Current state at deferral:** Reader function existed (migration 0003); fail-closed behavior verified by tests. No middleware set it — `withTenantContext` test helper was the only setter.
- **Resolution:** F01 Slice A — `bindTenantToDbSession` in `@cortex/tenant-context` calls `SELECT set_config('app.tenant_id', $1, true)` inside transactions; `ensureBoundToTenant` reads from the async-local store and binds. Middleware factory threads tenant id from HTTP layer through async context → DB session var. End-to-end exercised by 6 db-session tests + 8 audit tests + 19 tenants tests.
- **References:** ADR-DB-002 §Decision 1, migration 0003, `packages/tenant-context/src/db-session.ts`, `packages/tenant-context/src/middleware.ts`.

### 7.5 RLS FORCE flag (test-only) — Resolved 2026-04-25 / commit `4811821`

- **Item:** `ALTER TABLE ... FORCE ROW LEVEL SECURITY` enabled in tests
- **Current state at deferral:** Tests ran as `postgres` superuser which bypasses RLS unless FORCE was set; test fixtures used FORCE.
- **Resolution:** Production runtime SAs are non-superuser, so RLS applies without FORCE on the new control-plane tables (`tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`). Tests use FORCE selectively where the table owner happens to equal the test connection role (`audit_event` only); `packages/tenant-context/test/helpers/db.ts:forceRlsOnAuditEvent` isolates the pattern. Production posture: no FORCE needed; runtime non-bypass roles inherit RLS by default.
- **References:** CLAUDE.md "Testing RLS-protected tables", ADR-DB-002, `packages/tenant-context/test/helpers/db.ts`.

### 10.1 Control-plane database location — Resolved 2026-04-25 / commit `4811821`

- **Item:** Where do F01's control-plane tables (`tenant`, `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`) live?
- **Current state at deferral:** Not decided. Three options: same `cortex` DB / same Cloud SQL instance separate DB / separate Cloud SQL instance.
- **Resolution:** Single `cortex` DB chosen — control plane co-located with tenant data. Migration 0007 added the four control-plane tables in the `cortex` Postgres database. Phase 1 reality: 1 tenant; co-location has no isolation downside at this scale. Trigger to revisit (separate `cortex_control` DB or per-Enterprise dedicated instances) remains in §1.2 (Cloud SQL Enterprise Plus upgrade) and the deferred Enterprise tier work; F02 may revisit at multi-tenant traffic.
- **References:** Build prompts §F01 §1.4, `services/foundation/migrations/0007_control_plane_tables.sql`.

### 10.6 Async-local context propagation library — Resolved 2026-04-25 / commit `4811821`

- **Item:** Node.js `AsyncLocalStorage` wrapper for tenant context
- **Current state at deferral:** No existing pattern in the repo. `packages/tenant-context/` was an empty shell.
- **Resolution:** F01 Slice A — package now has 8 source files (`errors`, `types`, `context`, `db-session`, `audit`, `tenants`, `middleware`, `index`) with 65 tests (12 errors + 10 context + 6 db-session + 8 audit + 19 tenants + 10 middleware). Public API: bare `AsyncLocalStorage` from `node:async_hooks` wrapped in helpers (`getTenantId` / `getTenantOrThrow` / `withTenantContext` / `withoutTenantContext`); DB session-var bridge; audit emission; tenant CRUD namespace; framework-agnostic HTTP middleware (Hono + Express adapters).
- **References:** Build prompts §F01 §1, `packages/tenant-context/src/`.

### 4.1 `@cortex/observability` library — Resolved 2026-04-25 / commit `15e5574`

- **Item:** pino + OpenTelemetry SDK + prom-client-compatible API library
- **Current state at deferral:** P0.6 Phase 1 (operator infrastructure) shipped; Phase 2 library not started. Interim audit logging used stderr `[SECRETS-AUDIT]` + `[BOOTSTRAP-AUDIT]` prefixes as placeholder.
- **Resolution:** P0.6 Phase 2 — package ships 13 src files (`errors` / `types` / `context-provider` / `redaction` / `logger` / `sdk` / `tracer` / `metrics` / `correlation-context` / `http-middleware` / `grpc-middleware` / `pubsub-wrapper` / `test-utils`) plus the public barrel, with 77 unit tests across 9 spec files. Cloud Logging-compatible JSON output (severity / timestamp / message / module_id / context fields); ContextProvider wires `tenant_id` (F01 store), `correlation_id` (observability's own AsyncLocalStorage), `trace_id` / `span_id` (OTel active context); path-based PII redaction at the logger boundary per ADR-OBS-003; framework-agnostic HTTP / gRPC / Pub/Sub middleware; `@cortex/observability/test-utils` subpath export for the `LogCapture` helper.
- **References:** ADR-OBS-001, ADR-OBS-003, `packages/observability/src/`, `docs/planning/p0-6-observability-scope.md`.

### 8.1 `[SECRETS-AUDIT]` swap — Resolved 2026-04-25 / commit `15e5574`

- **Item:** Swap stderr emission to `@cortex/observability` structured logger
- **Current state at deferral:** `console.error` with `[SECRETS-AUDIT]` JSON-line prefix at `packages/secrets/src/audit.ts`.
- **Resolution:** `audit.ts` refactored to hybrid DI — `createSecretsAuditEmitter(opts)` factory + module-scope default emitter backing the existing `auditLog(entry)` API + `__setLoggerForTesting` / `__resetForTesting` escape hatches. Emissions go through pino with `namespace: 'secrets-audit'`, `module_id: 'cortex-secrets'`. The 14 internal call sites in `kms.ts` / `secret-manager.ts` / `per-tenant-keys.ts` are unchanged; 16 prefix-string test assertions migrated to structured-field assertions via the `LogCapture` test-utils pattern.
- **References:** `packages/secrets/src/audit.ts`, `packages/secrets/test/{kms,per-tenant-keys,secret-manager}.spec.ts`.

### 8.2 `[BOOTSTRAP-AUDIT]` swap — Resolved 2026-04-25 / commit `15e5574`

- **Item:** Swap stderr emission to `@cortex/observability` structured logger
- **Current state at deferral:** `console.error` with `[BOOTSTRAP-AUDIT]` JSON-line prefix at `scripts/bootstrap/lib/bootstrap.ts`.
- **Resolution:** Same hybrid-DI pattern as §8.1 — `createBootstrapAuditEmitter(opts)` factory + module-scope default + `__setLoggerForTesting` / `__resetForTesting`. Emissions carry `namespace: 'bootstrap-audit'`, `module_id: 'cortex-bootstrap'`. The 5 internal `emitAuditLog` call sites in `runBootstrap` are unchanged; the prior `captureAllLogs` test helper retired in favor of `LogCapture`. Password-leakage tests gain defense-in-depth: a small `captureConsoleAndStreams` helper preserves the "no password ever escapes" check across both the structured-logger path and any stray write to console / stderr / stdout.
- **References:** `scripts/bootstrap/lib/bootstrap.ts`, `scripts/bootstrap/lib/bootstrap.test.ts`.

### 9.7 F01 compute isolation: K8s namespace vs Cloud Run — Resolved 2026-04-26 / commit `dcc503c`

- **Item:** F01 build prompt §3 says "Kubernetes namespace per Enterprise tenant"; Cortex platform is Cloud Run.
- **Current state at deferral:** Anticipated deviation; F01 had not shipped its compute-isolation surface. Three options were live: per-Enterprise Cloud Run service, dedicated revision pool with workload-identity isolation, or K8s migration.
- **Resolution:** F01 Slice C — **ADR-COMPUTE-001** locks Cloud Run service-per-Enterprise-tenant (option 1) plus a single shared service for Standard tenants. Service-name format: `{workload}-shared` (Standard) or `{workload}-tenant-{uuid}` (Enterprise) — fits the 63-char Cloud Run service-name budget with a 19-char workload cap. The `@cortex/compute-placement` package ships `getComputePlacement` (Phase 1 stub returns shared unconditionally) and `parseCloudRunServiceName` (parses both formats for forensics). Per-Enterprise dedicated services are provisioned at the F02 layer; Slice C ships only the resolver substrate. K8s migration is a future-trigger if Cloud Run isolation proves insufficient (would require a new ADR superseding ADR-COMPUTE-001).
- **References:** `docs/architecture/decisions/ADR-COMPUTE-001-cloud-run-vs-k8s-compute-isolation.md`, `packages/compute-placement/src/get-placement.ts`, `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md` (F02 swap contract).

### 10.3 Tenant tier discriminator — Resolved 2026-04-26 / commit `dcc503c`

- **Item:** How does F01 know whether a tenant is Standard or Enterprise?
- **Current state at deferral:** Spec mentioned "hybrid model: shared Postgres with RLS for Standard; dedicated Cloud SQL for Enterprise" but the tier field wasn't pre-defined. Three options live: typed text column with CHECK, enum type, or feature-flag-derived.
- **Resolution:** Substrate landed in **F01 Slice A** (commit `4811821`) — `tenant.tier text NOT NULL CHECK (tier IN ('STANDARD', 'ENTERPRISE'))` per migration 0007 (option 1). Default at insert time is `'STANDARD'`. Slice C confirms the consumer model: `@cortex/compute-placement` reads `tenant.tier` to branch shared vs dedicated placement (per ADR-COMPUTE-001 §3 and the F02 swap-path doc Resolver 2). Quotas use the same column for tier-default lookup (`@cortex/quotas` `getQuotaConfig(tier, resourceClass)` reads `DEFAULT_TIER_QUOTAS[tier]` per planning Decision 7). Enum type was rejected: text + CHECK is easier to evolve and inspect; feature-flag-derived was rejected: tier is a commercial-contract property and belongs on the row, not in flag config.
- **References:** `services/foundation/migrations/0007_control_plane_tables.sql` (CHECK constraint), `packages/quotas/src/types.ts` (DEFAULT_TIER_QUOTAS keyed by `QuotaTier`), `packages/compute-placement/src/get-placement.ts` (Phase 1 stub; F02 will branch on tier), `docs/architecture/f02-swap-paths-for-slice-c-resolvers.md` Resolver 2.

### 10.5 Quota enforcement implementation — Resolved 2026-04-26 / commit `dcc503c`

- **Item:** Token bucket per tenant per resource class (DB connections, CPU seconds, RAM MB, API calls/min)
- **Current state at deferral:** Not implemented. F01 prompt §6 specified the requirement. Three options live: in-memory + Redis-backed shared state, Memorystore Redis with Lua scripts, or Cloud-native API Gateway / Apigee.
- **Resolution:** F01 Slice C — `@cortex/quotas` ships token-bucket runtime backed by Postgres `tenant_quota_usage` (RLS-protected) using atomic `INSERT ... ON CONFLICT DO UPDATE` upserts as the per-window concurrency primitive. No Redis (option 1's shared-state half rejected: PG is already the cross-instance source of truth and the upsert primitive is atomic at row-level without an additional dependency). 4 resource classes shipped: `api_calls_per_minute` + `db_connections` (60s windows), `cpu_seconds` + `ram_mb` (3600s windows). Window boundaries are `date_trunc('minute' | 'hour', clock_timestamp() AT TIME ZONE 'UTC')` for cross-region determinism. Strict-greater (`>`) `current_value > quota_limit` enforces "exceeded" semantic. On rejection: returns a discriminated `CheckQuotaResult` (return-not-throw — caller's transaction owns the audit emission, so a thrown rejection would roll back the audit row alongside the upsert; see convention doc §1). HTTP middleware (framework-agnostic core + Hono/Express adapters) translates rejection to 429 + Retry-After + `QUOTA_EXCEEDED` audit event (REJECT verb per ADR-AU-001 Decision 3). Per-tier defaults from `DEFAULT_TIER_QUOTAS` table (`getQuotaConfig` Phase 1 stub); F02 will swap to `tenant_config_version`-backed per-tenant overrides per the swap-path doc Resolver 1. BigInt-native counters at the API surface (DB returns text from raw `db.execute`, coerced via explicit `BigInt()`).
- **References:** `packages/quotas/src/check-quota.ts`, `packages/quotas/src/middleware.ts`, `packages/quotas/src/config.ts`, `services/foundation/migrations/0007_control_plane_tables.sql` (`tenant_quota_usage` table + RLS), `docs/architecture/quotas-compute-placement-convention.md`, `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md` Decisions 6–9.

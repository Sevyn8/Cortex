# F01 Slice B: Encryption + Blob Isolation — Scope

**Status:** Scoping complete, implementation queued
**Scoped:** 2026-04-26
**Primary sources:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.1 (lines 933–996), Cortex v2.2 Spec §F01-FR-004 / §F01-FR-005, F01 §1.2.4 (encryption), F01 §1.5 (blob storage), ADR-INFRA-004
**Companion ADR:** ADR-INFRA-007 (per-tenant CMEK migration path)

---

## Context

F01 P1.1 is sliced three ways: Slice A (tenant context + DB isolation, shipped 2026-04-25 / commit `4811821`), Slice B (encryption + blob isolation, this doc), Slice C (quotas + compute isolation, deferred to a follow-up scope doc). Slice A landed the substrate that Slice B writes to: the `tenant_kms_key` and `tenant_quota_usage` control-plane tables (migration 0007), the async-local tenant context, the DB session bridge that RLS reads, and the CRUD surface (`tenants.create` / `update` / `setStatus`) that mutates the registry transactionally.

Slice B picks up two of the four remaining F01 §1 line items. F01 §1.2.4 calls for "transparent envelope encryption for PII-classified columns" with "per-tenant CMEK via /packages/secrets". F01 §1.5 calls for "tenant-prefixed paths in GCS: gs://cortex-{env}-{tier}/tenants/{tenant_id}/..." with "IAM bindings via Workload Identity" and a "pre-signed URL generator that embeds tenant scope". Both line items are unblocked by Slice A's substrate plus P0.7's `@cortex/secrets` envelope helpers (KEK is `cortex-general-key`, AAD = `utf8(tenantId)`, AEAD = AES-256-GCM); both must integrate with the SHA-chained audit emission from P0.10's `@cortex/audit-events`.

Three pre-existing constraints shape the Slice B surface:

- **Per-tenant CMEK is deferred to F02 (Phase 2+).** ADR-INFRA-004 §Decision 5 made this call. `getKeyForTenant(tenantId)` in `@cortex/secrets` is a Phase-1 stub returning the env's `cortex-general-key` regardless of tenant. Roadmap §1.1 / §7.1 track the stub's lifecycle. Slice B must ship something useful TODAY without inventing real per-tenant key creation; ADR-INFRA-007 (companion) records the migration path.
- **Two-category audit model from P0.10.** Compliance events flow through `audit_event` via `emitAuditEvent` (chain integrity); operational/debug events flow through `@cortex/observability` pino logs. Encryption operations are mostly compliance-relevant (PII access is auditable); some are not (key resolution telemetry is operational). The split must be drawn deliberately in this slice.
- **One Cortex tenant exists today (Display Data).** Phase 1 reality is small-scale. Bucket-per-tenant, per-tenant SA, per-tenant KMS — all are right long-term but premature today. Slice B picks the simplest correct posture and defers the multi-tenant fan-out work to F02 / D-series triggers.

The pre-flight audit (this session, `git status` snapshot post-P0.10 commits) confirmed working tree clean. Sub-phase 1 begins from a known-good baseline.

## In scope

### Library: `/packages/encryption`

`@cortex/encryption` package wrapping `@cortex/secrets`'s envelope helpers with tenant-bound semantics, audit emission, and a zod-validated typed surface. Public API:

- `encryptForTenant(db, params)` — envelope-encrypt a plaintext for a tenant. Resolves the tenant's key via `getKeyForTenant(tenantId)`, calls `envelope.encrypt(tenantId, plaintext)` (which sets AAD = utf8(tenantId)), emits a `PII_ENCRYPTED` audit event into `audit_event`, returns a `CiphertextEnvelope`.
- `decryptForTenant(db, params)` — symmetric inverse. Auth-tag mismatch (cross-tenant smuggling, ciphertext tampering) raises `EncryptionDecryptError`. Emits `PII_DECRYPTED` audit event.
- Hybrid DI mirroring P0.10: `createEncryptionService(opts)` factory + module-scope default backing the convenience exports + `__setServiceForTesting` / `__resetForTesting`.
- Module-load cycle break: type-only `Logger` import + dynamic `await import('@cortex/observability')` — the §4.13 pattern from P0.10's `emit.ts`.

### Library: `/packages/blob-storage`

`@cortex/blob-storage` package wrapping GCS path generation and pre-signed URL issuance with tenant-scoped semantics. Public API:

- `buildTenantPath(tenantId, parts)` — assembles `tenants/{tenantId}/{...parts}`. Validates `tenantId` (UUID) and rejects path components containing `..`, leading `/`, or null bytes. Returns the object key (no bucket prefix — bucket is the caller's concern).
- `parseTenantPath(objectKey)` — inverse: extracts `tenantId` from a path or throws `BlobStoragePathError`. Used to validate inbound paths from URL params / signed-URL audits.
- `getSignedUploadUrl(params)` / `getSignedDownloadUrl(params)` — wraps `@google-cloud/storage`'s `getSignedUrl`, hard-codes `version: 'v4'`, enforces a TTL cap (15 min default, 24 hr max), validates that the requested object key starts with `tenants/{tenantId}/`. Emits `BLOB_SIGNED_URL_ISSUED` audit event.
- Hybrid DI: `createBlobStorageService({ bucketName, storage?, signerSa? })` factory + module-scope default + test escapes.

### Substrate update: `tenant_kms_key` INSERT path in `@cortex/tenant-context`

`tenants.create(db, input, ctx)` extends to insert one `tenant_kms_key` row in the same transaction. The row's `kms_key_resource_name` is computed via `getKeyForTenant(tenantId)` — which today resolves to the env's `cortex-general-key`. F02 swaps both the `getKeyForTenant` lookup and the row contents to point at a real per-tenant KMS key; envelope format is unchanged across the swap (ADR-INFRA-007).

The INSERT is transactional with the `tenant` row creation: if the `tenant_kms_key` insert fails, the whole creation rolls back. A `TENANT_KMS_KEY_BOUND` audit event is emitted alongside.

### Terraform: 1 application-tier GCS bucket per env

New module instance: `cortex-{env}-tenant-data` bucket per env (dev/staging/prod). Posture:

- Uniform bucket-level access (no object ACLs).
- CMEK via `cortex-gcs-key` (per ADR-INFRA-004 §Decision 5; key already exists in each env keyring).
- Lifecycle: 90-day cold-storage transition for objects under `tenants/*/archive/*`; 365-day delete for `tenants/*/tmp/*`. Production-tier objects (`tenants/*/canonical/*`) have no lifecycle action.
- IAM: per-env runtime SA (`tenant-data-runtime@{project}.iam.gserviceaccount.com`) gets `roles/storage.objectAdmin` on the bucket. NO per-tenant SAs (deferred — see Out of scope).
- Versioning enabled. Public access blocked.
- Retention policy not set in Phase 1 (object-level deletion still allowed). SCR-20 retention enforcement is a separate concern at the audit-archival layer.

### ADR-INFRA-007: per-tenant CMEK migration path

Companion ADR locking the bridge from "Slice B substrate (tenant_kms_key row pointing at env key)" to "F02 real per-tenant KMS keys". Resolves the integration question for D-series PII columns: encrypt today, decrypt forever — no envelope format change, no data re-encryption when F02 swaps the resolver.

## Deferred (explicitly out of scope)

Each entry below becomes a roadmap entry (or stays as one) in sub-phase 10.

- **Real per-tenant KMS keys.** Still using env's `cortex-general-key` per ADR-INFRA-004 §Decision 5. F02 ships per-tenant key creation at provisioning + flips `getKeyForTenant` to consult `tenant_kms_key`. Roadmap §1.1.
- **Bucket-per-tenant for ENTERPRISE tier.** Phase 1 has only STANDARD-tier tenants. F02 lifecycle ships dedicated buckets when an Enterprise tenant onboards; Slice B's path generator already produces tenant-prefixed keys, so the migration is purely IAM + bucket-resolver. Roadmap §10.7.
- **Per-tenant SA / IAM scoping.** Current model is one shared `tenant-data-runtime` SA with `roles/storage.objectAdmin` on the bucket; tenant isolation comes from path enforcement in `@cortex/blob-storage` plus pre-signed URL audience constraints. Per-tenant SAs (one SA per tenant with object-prefix conditions) are heavier (more SAs to manage) and only justified at multi-tenant scale. Roadmap §10.7 / §10.8.
- **Quotas + Compute isolation (Slice C).** Token bucket on `tenant_quota_usage` UPDATEs (Decision 5), Cloud Run / K8s isolation posture (Decision 6). Separate scope doc + ADR when Slice B closes.
- **F02 lifecycle automation that swaps the stub.** F02 owns: real KMS key creation per tenant, `getKeyForTenant` resolver swap, key rotation primitives, dedicated-bucket provisioning for Enterprise tier. Slice B ships substrate; F02 ships the swap.
- **PII column auto-encryption at the ORM layer.** Drizzle does not have a transparent column-level encryption hook; D01-D06 column writers will call `encryptForTenant` explicitly (per-table custom types, codified in the convention doc — sub-phase 9). Auto-encryption is deferred until a D-series module surfaces enough repetition to warrant a generalized helper.
- **Re-encryption / key rotation primitives.** Out of Phase 1. F02 ships rotation when real per-tenant keys land. Envelope format includes a wrap-version byte; rotation re-wraps DEKs (not data ciphertext). Roadmap §1.1.
- **Cross-region GCS replication / multi-region buckets.** Phase 1 single-region bucket per env (region matches the env's Cloud SQL region per ADR-INFRA-005). DR / multi-region is a Phase 2+ concern.
- **Audit-event indexes for blob-storage / encryption query patterns.** Same posture as P0.10 §4.11: ship without indexes; design indexes when SCR-22 elevated-review surfaces actual query shapes. No speculative indexing.

## Decisions

### Decision 1 — Pre-flight: working tree clean (no action)

**Decision.** No working-tree cleanup needed before Slice B begins. The Section A audit's "dirty tree" report reflected the system's start-of-session `gitStatus` snapshot, which predates the P0.10 commits (`0f4a99b`, `b1a23a1`); a fresh `git status` confirms `nothing to commit, working tree clean`.

**Reasoning.** The `gitStatus` block in the conversation header is a snapshot at session start and does not refresh as the conversation progresses. Verified via `git diff pnpm-lock.yaml` (empty), `git diff pnpm-workspace.yaml` (empty), `git status packages/observability/` (clean), and `git reflog` (P0.10 commits at HEAD@{0..1}, no stray resets).

### Decision 2 — Two packages: `@cortex/encryption` + `@cortex/blob-storage`

**Decision.** Two new workspace packages, not one combined `@cortex/storage` umbrella. `@cortex/encryption` owns envelope encryption (PII columns, opaque blobs of bytes); `@cortex/blob-storage` owns GCS path generation and signed URL issuance. They do not depend on each other; downstream consumers can import either independently.

**Reasoning.** F01 §1.2.4 (encryption) and §1.5 (blob storage) are different concerns at different boundaries: encryption is a CPU-bound cryptographic transform on bytes, blob storage is a GCS API wrapper with IAM and signing. A combined package would force every consumer of one to accept the dependency surface (and KMS / GCS clients) of the other. Mirrors the `@cortex/secrets` (KMS + Secret Manager — same vendor, same trust boundary, justifiable union) vs `@cortex/audit-events` (separate boundary) split established in Phase 0.

**Alternatives considered.** Combined `@cortex/storage` package (rejected — couples cryptography and GCS); roll encryption into `@cortex/secrets` (rejected — `@cortex/secrets` is the env-level Secret Manager + KEK boundary; per-tenant data plane is a different abstraction layer).

### Decision 3 — `tenant_kms_key` INSERT synchronous at tenant creation, transactional

**Decision.** `tenants.create(db, input, ctx)` extends to insert exactly one `tenant_kms_key` row in the SAME transaction as the `tenant` INSERT. The row's `kms_key_resource_name = getKeyForTenant(newTenantId)` (Phase 1 stub returns the env's `cortex-general-key`). A `TENANT_KMS_KEY_BOUND` audit event is emitted alongside `TENANT_CREATED` in the same transaction.

**Reasoning.** Every tenant must have a `tenant_kms_key` row from the moment it exists; F02 will rely on this row's presence as a precondition for per-tenant key swap. Async / lazy provisioning would create a window where a tenant exists without a key binding — encrypt operations would have to handle the missing-row case, complicating the API surface. Transactional bundling: if the kms_key INSERT fails (e.g., RLS misconfiguration), the whole tenant creation rolls back; we never end up with a tenant that has no key binding.

**No GCP API call.** The Phase 1 stub does not create a real KMS key — `getKeyForTenant` returns a string. Provisioning latency is unchanged from Slice A; the tenant-creation transaction stays small. F02's per-tenant key creation will introduce real KMS API calls (and their failure modes); ADR-INFRA-007 captures the migration.

**Alternatives considered.** Lazy/on-first-encrypt INSERT (rejected — racy under concurrent encryption requests for a new tenant); deferred async background-worker provisioning (rejected — premature complexity for Phase 1; F02 will revisit if real key creation latency warrants async); separate `tenants.bindKmsKey()` method called by F02 (rejected — redundant; F02's swap is a row UPDATE, not a fresh INSERT).

### Decision 4 — Shared bucket with `tenants/{tenantId}/` prefix; bucket-per-tenant deferred for ENTERPRISE

**Decision.** One `cortex-{env}-tenant-data` bucket per env, with object keys conforming to `tenants/{tenantId}/{...path}`. Path enforcement lives in `@cortex/blob-storage`; tenants never construct raw object keys. Bucket-per-tenant is deferred until the first ENTERPRISE-tier tenant onboards (F02 owns the dedicated-bucket provisioning at that time).

**Reasoning.** Phase 1 has one tenant. Three buckets per env (one shared + two reserved for tier upgrade) is operational overhead with zero isolation gain. Path-prefix isolation plus pre-signed URL audience scoping is sufficient against the threat model (operator code carrying a stale tenantId; SQL injection; URL-tampering). Cross-tenant blob access via API requires either (a) a tenant context bound to wrong tenant — caught by Slice A's RLS substrate at the row level, but blob storage is not RLS-protected so the path validator IS the enforcement boundary; (b) a signed URL for tenant A used to access tenant B's path — caught by the URL's path component being verified at sign time. Neither requires bucket-level separation.

**Trade-off accepted.** Operational visibility (per-tenant bucket usage metrics) is harder with shared buckets — Cloud Storage usage metrics are bucket-level. Mitigation: object-level metrics are queryable via Cloud Logging (every operation emits an object-level audit log entry), and OB03 (metering, deferred to Phase 2) can roll up per-tenant metrics from those logs. Roadmap §1.6 already tracks per-tenant infra-metric tagging.

**Alternatives considered.** Bucket-per-tenant from day one (rejected — ~3× operator overhead per env at one tenant; bucket-creation rate limits in GCP would constrain provisioning velocity at scale anyway); bucket-per-tier with shared STANDARD bucket and dedicated ENTERPRISE bucket (rejected — same operational overhead, only deferred slightly); single bucket cross-env (rejected — violates env-isolation posture from ADR-INFRA-002).

### Decision 5 — Quotas DB-backed via `tenant_quota_usage` UPDATEs (Slice C, not today)

**Decision.** Slice C, separate scope doc. Token bucket built on top of `tenant_quota_usage` row UPDATEs inside the request transaction; 429 + Retry-After at the HTTP middleware layer; metric emission per throttle event. Roadmap §10.5 captures the three options (DB-backed token bucket, in-memory rate limit, Cloud-native via API Gateway / Apigee); Slice C picks DB-backed.

**Reasoning for deferring to Slice C.** Slice B already touches: 2 new packages, 1 new ADR, 1 Terraform module instance, 1 substrate INSERT path migration. Bundling quota enforcement (which spans HTTP middleware extension, a token-bucket implementation against `tenant_quota_usage` columns, integration tests for 429 latency budget < 50ms per F01 acceptance) blows the slice scope. Slice C ships standalone with its own scope doc + ADR.

**Locked here so Slice B can refer to it without ambiguity.** Encryption / blob-storage operations DO NOT count against quota in Slice B; quota counters are introduced in Slice C and integrated retroactively into existing call paths. The convention doc (sub-phase 9) flags which call sites will gain quota checks at Slice C.

### Decision 6 — Compute isolation: stub + ADR (Slice C, not today)

**Decision.** Slice C lands a stub-shape ADR (ADR-F01-001 or similar) capturing Cortex's compute posture: Cloud Run, not K8s. F01 build prompt §3 specifies "Kubernetes namespace per Enterprise tenant" — that's a deviation Slice C records. Per-service Cloud Run instances + per-tenant resource budgets (RAM / CPU per request) replace the K8s namespace model. Roadmap §9.7 already anticipates this.

**Reasoning for deferring to Slice C.** Same scope-discipline argument as Decision 5. Compute isolation is a deployment-and-posture decision more than a code deliverable; a Slice-C ADR + Terraform tweaks is the right shape. Roadmap §9.7 already exists as the placeholder.

**Locked here so Slice B Terraform can be designed correctly.** The `tenant-data-runtime` SA in Slice B Terraform is per-env, NOT per-tenant. Slice C may revisit if a Cloud Run revision policy demands per-tenant SAs (no current evidence it does).

### Decision 7 — Slice B before Slice C

**Decision.** Slice B ships before Slice C in the F01 timeline. Display-Data (Phase 1 launch tenant) needs PII encryption + blob upload before it needs quota enforcement (Display-Data is a single-customer ramp; quota incidents surface only at multi-tenant scale).

**Reasoning.** F02 (P1.2) is gated by F01 fully closing; F02's first deliverable (lifecycle state machine) needs encryption substrate (to know what to do at provisioning) more than it needs quota substrate (lifecycle ops are infrequent and operator-driven). Encryption + blob storage also unblock D01 (PII columns) and D02 (canonical entities) earlier, which matters for the P1.3 (F03 Temporal Data Engine) sequencing. Quota is a horizontal capability that can land any time before P11.x without blocking forward progress.

**Alternatives considered.** Slice C first (rejected — see above); Slices B + C in parallel (rejected — both touch Slice A surface, sequencing keeps the diffs reviewable; also a single-developer constraint).

### Decision 8 — Full Slice B implementation today (one long session)

**Decision.** All 10 sub-phases ship in one session, with HOLD-for-review checkpoints between each. Total estimated 14–18 hours; spread across whatever calendar time the user wants but logically one session — no half-shipped state at any commit point.

**Reasoning.** P0.10 cadence (10 sub-phases, similar complexity, ~10–12 hours actual) established the working pattern. Slice B is slightly larger (Terraform module instance + 2 packages instead of 1) but the precedent shows the cadence works. Single-session shipping avoids the cost of re-paging context between work blocks; HOLD-for-review checkpoints keep approval granularity per sub-phase rather than per-session.

**Caller contract for the session.** Each sub-phase produces commit-ready code/docs but is NOT committed until sub-phase 10's aggregate commit (single squash, prompt-id `Prompt: P1.1 Slice B`). Mirrors P0.10's two-commit landing (one feat commit, one docs(progress) commit).

## Sub-phases

Slice B uses sub-phase numbering rather than phase numbering, mirroring P0.10. Sub-phase 1 is THIS scope doc + ADR-INFRA-007.

| #   | Title                                                        | Estimate | Deliverable                                                                                                                                                                                                                                                                                    | Acceptance                                                                                                                                                                                                                           | Dependencies        |
| --- | ------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| 1   | Planning doc + ADR-INFRA-007                                 | 1 hr     | This doc + `docs/architecture/decisions/ADR-INFRA-007-per-tenant-cmek-migration-path.md`.                                                                                                                                                                                                      | Both files lint-clean; cross-references resolve; review approved.                                                                                                                                                                    | none                |
| 2   | `tenant_kms_key` INSERT path in `@cortex/tenant-context`     | 1.5 hr   | `tenants.create` extended to insert `tenant_kms_key` row in the same transaction; resolver call to `getKeyForTenant`; new audit event `TENANT_KMS_KEY_BOUND` (extends `TENANT_AUDIT_ACTIONS`). 2 new tests (success + rollback-on-failure).                                                    | Every `tenants.create` produces exactly one `tenant_kms_key` row referencing the env's `cortex-general-key`. Failure path: forced kms_key INSERT failure rolls back the tenant row. Existing 19 `tenants.spec.ts` tests still green. | sub-phase 1 (locks) |
| 3   | `@cortex/encryption` scaffold + types + errors + zod schemas | 2 hr     | New package directory; `package.json` + workspace registration; `src/types.ts` (CiphertextEnvelope, EncryptForTenantParams discriminated by purpose); `src/errors.ts` (EncryptionError hierarchy); `src/schemas.ts` (zod-validated params).                                                    | `pnpm typecheck` clean for the package; `pnpm lint` clean; package added to `pnpm-workspace.yaml`; barrel not yet wired (sub-phase 5 owns it).                                                                                       | sub-phase 1         |
| 4   | `encryptForTenant` / `decryptForTenant` + audit emission     | 2.5 hr   | `src/emit.ts` equivalents wrapping `@cortex/secrets.envelope.encrypt/decrypt`; hybrid-DI factory + module-scope default + test escapes; type-only Logger import + dynamic observability resolution per §4.13 cycle-break pattern; audit emission on every encrypt/decrypt.                     | Round-trip works against live KMS (Phase 1 dev env). Audit row emitted in caller's transaction. Cross-tenant decryption fails at AAD (auth-tag mismatch) — verified inline before sub-phase 6 broadens.                              | 2, 3                |
| 5   | `ENCRYPTION_AUDIT_ACTIONS` catalog + index barrel            | 1 hr     | `src/audit-actions.ts` declaring `PII_ENCRYPTED` / `PII_DECRYPTED` / `BLOB_SIGNED_URL_ISSUED` (used by sub-phase 7) via `registerAuditActions([...] as const)`. `src/index.ts` public barrel.                                                                                                  | Barrel exports stable surface; downstream consumers import via package root only; catalog name regex passes `AUDIT_ACTION_NAME_REGEX`.                                                                                               | 4                   |
| 6   | Encryption tests (unit + integration against p09-repro)      | 2.5 hr   | `test/encrypt.spec.ts`, `test/decrypt.spec.ts`, `test/cross-tenant.spec.ts` (AAD smuggling rejection), `test/audit-emission.spec.ts`. Mock-DB unit tests for shape, integration tests for chain integrity + RLS denial. ~28–35 tests.                                                          | All tests green against p09-repro with real `cortex-general-key`. Cross-tenant decryption test produces the expected auth-tag failure path. Workspace test count delta visible at sub-phase 10.                                      | 4, 5                |
| 7   | `@cortex/blob-storage` package — full                        | 3 hr     | New package: `path.ts` (build/parse), `signed-url.ts` (v4 signing wrapping `@google-cloud/storage`), audit emission, hybrid DI, types, errors, schemas, catalog, barrel, tests. ~30 tests covering path validation, TTL caps, audit emission, cross-tenant URL rejection.                      | `pnpm test` green; tenant-prefix path enforcement rejects `..`, leading slashes, null bytes, cross-tenant attempts; signed URL TTL is capped (15 min default, 24 hr hard max).                                                       | 1, 5                |
| 8   | Terraform: `cortex-{env}-tenant-data` bucket + IAM           | 1.5 hr   | New module instance in each env's `main.tf`; `cortex-gcs-key` CMEK reference; `tenant-data-runtime` SA + IAM bindings (storage.objectAdmin); uniform bucket-level access; lifecycle rules per Decision 4. `terraform fmt` + `terraform validate`.                                              | `make tf-plan-dev` produces a clean, reviewable plan; no apply this sub-phase (apply is a separate review, after the user approves the diff). Outputs include the bucket name + KMS binding for runtime config consumers.            | 7 (path layout)     |
| 9   | Convention doc + CLAUDE.md update + status.md                | 1 hr     | `docs/architecture/encryption-and-blob-storage-convention.md` (when to encrypt, when to audit, path conventions, signed-URL TTL guidance, key-resolution stub behavior); CLAUDE.md "Encryption & Blob Storage" subsection; status.md Slice B checkbox flipped + commit-hash placeholder.       | All cross-references valid; conventions reflect what sub-phases 2–8 actually shipped (no aspirational drift).                                                                                                                        | 4–8                 |
| 10  | Final aggregate + commit + push + roadmap backfill           | 1 hr     | Full workspace test pass; lint clean; tsc clean; commit (one `feat(P1.1 Slice B)` + one `docs(progress)`); push to origin/main; roadmap edits: §10.7 (blob layout) → Resolved; §1.1 (per-tenant CMEK) → "In progress, Slice B substrate"; §7.1 (getKeyForTenant stub) → unchanged (still F02). | CI green on the feat commit (foundation tests); docs-only commit may show the cfe8347-pattern `failure` (non-blocking, documented). PR-equivalent review packet posted in chat for user.                                             | 1–9                 |

Total: ~16 hours nominal, with HOLD-for-review pauses between sub-phases.

## Risks & mitigations

- **KMS key creation rate at tenant provisioning.** Phase 1 stub does not call KMS at all — `getKeyForTenant` is a pure string builder. The risk surfaces only when F02 swaps to real per-tenant key creation. Mitigation: ADR-INFRA-007 §Consequences/Negative explicitly flags KMS billing + rate-limit considerations as F02's problem; Slice B carries no exposure today.
- **Cross-tenant encryption smuggling via AAD bypass.** `envelope.encrypt(tenantId, plaintext)` sets AAD = utf8(tenantId) (verified in `packages/secrets/src/kms.ts`). Decryption fails at `getAuthTag().verify` if AAD doesn't match. Mitigation: sub-phase 6 includes a dedicated cross-tenant test (encrypt for tenant A, attempt decrypt with tenant B context, assert `EncryptionDecryptError` with auth-tag-mismatch cause). The failure happens at the AEAD layer, not at the key-resolution layer — so this protection holds even when Phase 1 stub returns the same env key for both tenants.
- **p09-repro divergence from production migration path.** Slice B does NOT add a new SQL migration — the substrate (`tenant_kms_key` table) was added in 0007 by Slice A. Application-layer `INSERT` doesn't touch the migration path. Roadmap §1.10 still tracks the broader divergence; Slice B's exposure is zero on this front.
- **Module-load cycle if `@cortex/encryption` eagerly imports `@cortex/observability`.** Slice B repeats the §4.13 / P0.10 break pattern: type-only `import type { Logger } from '@cortex/observability'` + dynamic `await import('@cortex/observability')` resolved on first WARN. Mitigation: convention doc (sub-phase 9) calls out the pattern explicitly so future audit-emitting modules don't reintroduce the cycle.
- **Pre-signed URL TTL drift / leakage.** Long-lived signed URLs are a recurring class of incident (URLs forwarded, indexed, cached). Mitigation: `getSignedUploadUrl` / `getSignedDownloadUrl` cap TTL at 15 min default / 24 hr hard max; values above the hard max throw `BlobStorageValidationError`. Caller cannot opt out. Audit event records the TTL chosen so operator forensics can correlate URL issuance to access patterns.
- **Bucket misconfiguration (uniform vs ACL drift).** Terraform module sets `uniform_bucket_level_access = true` and `public_access_prevention = "enforced"`. Both must stay set across edits; a reviewer flipping one to allow legacy ACLs would silently weaken isolation. Mitigation: add a CI-check in `make tf-validate` (sub-phase 8) that asserts both flags are still set after any TF edit. Lower-priority — initial review catches it; CI-check is a roadmap follow-up if drift surfaces.
- **Audit-event volume from encrypt/decrypt operations.** Every PII column read/write would emit an audit row if naively wired in. Mitigation: convention doc (sub-phase 9) explicitly partitions which encryption operations audit (caller-attributed PII access — `decryptForTenant` from a request handler) vs which do not (intra-service round-trips, key-resolution telemetry — operational only, pino-logged). The two-category model from P0.10 carries directly. Roadmap §1.9 (audit payload size) and §1.6 (per-tenant infra metrics) compose with this.

## References

- **F01 build prompt §1.2.4** (encryption: per-tenant CMEK + envelope + key rotation), **§1.5** (blob storage: tenant-prefixed paths + WIF + signed URLs)
- **ADR-INFRA-004** — CMEK key hierarchy (env-level keys; per-tenant deferred to Phase 2+)
- **ADR-INFRA-007** (companion to this scope doc) — per-tenant CMEK migration path
- **ADR-AU-001** — audit-events library (direct DB INSERT; encryption emits via this)
- **ADR-DB-002** — RLS posture (control-plane tables that Slice B reads/writes)
- **Roadmap §1.1** — per-tenant CMEK keys (moves to "In progress, Slice B substrate")
- **Roadmap §7.1** — `getKeyForTenant` Phase 1 stub (unchanged; still F02)
- **Roadmap §9.7** — F01 compute isolation: K8s vs Cloud Run (Slice C)
- **Roadmap §10.7** — blob isolation IAM strategy (resolved by Slice B)
- **Roadmap §10.8** — pre-signed URL signing identity (resolved by Slice B — shared per-env SA)
- **Roadmap §1.10** — p09-repro `__drizzle_migrations` tracking backfill (carries forward)
- **Roadmap §4.13** — observability ↔ tenant-context decoupling (the cycle-break pattern Slice B reuses)
- **Build prompts §F01** at `docs/build-prompts/cortex_build_prompts_v3.md` lines 933–996
- **Cortex v2.2 Spec §F01-FR-004** (encryption requirements), **§F01-FR-005** (blob isolation requirements)
- **Migration `services/foundation/migrations/0007_control_plane_tables.sql`** — `tenant_kms_key` substrate (Slice A)
- **`packages/secrets/src/per-tenant-keys.ts`** — current `getKeyForTenant` stub
- **`packages/secrets/src/kms.ts`** — envelope encrypt/decrypt with tenantId AAD (Slice B builds on this)
- **`packages/tenant-context/src/tenants.ts`** — Slice A `tenants.create` (sub-phase 2 extends)
- **`packages/audit-events/src/`** — emission contract (sub-phases 4, 5, 7 emit through this)
- **`docs/planning/p0-10-audit-events-scope.md`** — precedent for sub-phase cadence + decision format

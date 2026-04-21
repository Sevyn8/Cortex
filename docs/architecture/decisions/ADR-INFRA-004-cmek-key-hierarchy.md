# ADR-INFRA-004: CMEK Key Hierarchy — Per-Resource-Class Keys Per Project, SOFTWARE Phase 1

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2.2 Spec §6 Security & Compliance; P0.3 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-002 (bootstrap), ADR-INFRA-003 (VPC topology)

---

## Context

Cortex is pitched to Display Data and future tenants as an **Enterprise-tier** platform. "What's your encryption posture?" is a standard question in enterprise procurement. The answer needs to satisfy four audiences simultaneously:

1. **Indian regulatory posture — DPDP (Digital Personal Data Protection Act, in force since 2025).** DPDP requires personal data to be protected by "reasonable security safeguards", which in practice means encryption at rest with controls over key access. Google-managed encryption alone satisfies the letter; customer-managed encryption (CMEK) satisfies the intent and is what enterprise buyers expect.

2. **Future SOC 2 Type II audit.** CC6.1 requires logical access controls including encryption of data at rest. Auditors specifically check for: customer-managed keys, documented rotation cadence, documented key-access IAM, and evidence that encryption is applied to all data-at-rest resources — not just the obvious ones.

3. **Enterprise procurement DPAs.** Data Processing Agreements routinely include clauses requiring "the Processor shall maintain customer-managed encryption keys" and "the Processor shall support cryptographic erasure upon Controller termination". The second clause is what this ADR enables — _revocation as a kill switch_. If a tenant leaves, revoking access to their key cryptographically renders their data inert without requiring a purge scan.

4. **Internal security hygiene.** Blast-radius containment is good hygiene even absent compliance pressure. A compromised credential should rotate out of one key class without touching adjacent classes; a classes-separated posture makes that possible.

The P0.3 build prompt scoped "CMEK on everything, per-resource-class keys per project". This ADR closes the design on which keys, where they live, what protection level, how they rotate, and when HSM enters the picture.

## Decision

**CMEK on every CMEK-capable resource. One key per (project, resource class) — 17 keys total in Phase 1. SOFTWARE protection for Phase 1; HSM for prod at P11.4. 90-day automatic rotation. No cross-project keys.**

Specifically:

1. **Per-resource-class keys.** Each env project has a keyring `cortex-keyring` holding 5 keys (one per major service class). The `tfstate` and `shared` projects each have a dedicated keyring holding exactly the key they need.

2. **17 keys total, all in `asia-south1`:**
   - 5 keys × 3 env projects (dev, staging, prod) = 15
   - 1 key in tfstate project (`cortex-tfstate-key`)
   - 1 key in shared project (`cortex-artifactregistry-key`)

3. **`SOFTWARE` protection for Phase 1** (Google software HSM backend). Upgrade to `HSM` (FIPS 140-2 Level 3) is scheduled for prod only at **P11.4**, before Display Data go-live. Dev and staging stay SOFTWARE indefinitely; HSM on non-prod is cost without benefit.

4. **90-day automatic rotation** on every key. GCP KMS mints a new primary version every 90 days; existing ciphertext remains decryptable by the corresponding older version.

5. **Per-tenant CMEK deferred to Phase 2+.** The data model (D01) needs tenant_id-to-key binding, and at one tenant the optionality isn't worth the architectural cost. When tenant count grows or a DPA specifically demands it, it becomes additive — new keys, no re-key of existing data.

6. **No cross-project keys.** Every key lives in one project; every CMEK reference stays within the owning project's scope. Cross-project scenarios are solved with narrow service-agent grants on specific keys, not shared keyrings.

7. **`lifecycle { prevent_destroy = true }` on every key.** Destruction requires a deliberate code change; GCP's 24-hour scheduled-destruction window is the second safety layer.

## Key inventory

All 17 keys, with location and purpose:

|   # | Project                 | Keyring                  | Key                           | Encrypts                                                                |
| --: | ----------------------- | ------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
|   1 | `sevyn8-cortex-dev`     | `cortex-keyring`         | `cortex-cloudsql-key`         | Cloud SQL instances (P0.4+) in dev                                      |
|   2 | `sevyn8-cortex-dev`     | `cortex-keyring`         | `cortex-gcs-key`              | GCS buckets in dev                                                      |
|   3 | `sevyn8-cortex-dev`     | `cortex-keyring`         | `cortex-pubsub-key`           | Pub/Sub topics in dev                                                   |
|   4 | `sevyn8-cortex-dev`     | `cortex-keyring`         | `cortex-secrets-key`          | Secret Manager secrets in dev                                           |
|   5 | `sevyn8-cortex-dev`     | `cortex-keyring`         | `cortex-general-key`          | Catch-all for dev resources not fitting 1–4                             |
|   6 | `sevyn8-cortex-staging` | `cortex-keyring`         | `cortex-cloudsql-key`         | Cloud SQL in staging                                                    |
|   7 | `sevyn8-cortex-staging` | `cortex-keyring`         | `cortex-gcs-key`              | GCS in staging                                                          |
|   8 | `sevyn8-cortex-staging` | `cortex-keyring`         | `cortex-pubsub-key`           | Pub/Sub in staging                                                      |
|   9 | `sevyn8-cortex-staging` | `cortex-keyring`         | `cortex-secrets-key`          | Secret Manager in staging                                               |
|  10 | `sevyn8-cortex-staging` | `cortex-keyring`         | `cortex-general-key`          | Catch-all for staging                                                   |
|  11 | `sevyn8-cortex-prod`    | `cortex-keyring`         | `cortex-cloudsql-key`         | Cloud SQL in prod                                                       |
|  12 | `sevyn8-cortex-prod`    | `cortex-keyring`         | `cortex-gcs-key`              | GCS in prod                                                             |
|  13 | `sevyn8-cortex-prod`    | `cortex-keyring`         | `cortex-pubsub-key`           | Pub/Sub in prod                                                         |
|  14 | `sevyn8-cortex-prod`    | `cortex-keyring`         | `cortex-secrets-key`          | Secret Manager in prod                                                  |
|  15 | `sevyn8-cortex-prod`    | `cortex-keyring`         | `cortex-general-key`          | Catch-all for prod                                                      |
|  16 | `sevyn8-cortex-tfstate` | `cortex-tfstate-keyring` | `cortex-tfstate-key`          | Terraform state bucket (`cortex-tfstate-5402eb`)                        |
|  17 | `sevyn8-cortex-shared`  | `cortex-keyring`         | `cortex-artifactregistry-key` | Artifact Registry repositories (cortex-apps, cortex-agents, cortex-mcp) |

All keys:

- Location: `asia-south1`
- Algorithm: `GOOGLE_SYMMETRIC_ENCRYPTION`
- Purpose: `ENCRYPT_DECRYPT`
- Protection level: `SOFTWARE` (Phase 1); prod keys (11–15) upgrade to `HSM` at P11.4
- Rotation period: `7776000s` (90 days)
- `lifecycle { prevent_destroy = true }`

The `cortex-general-key` in each env is intentionally broad — it catches services that emerge later and don't fit cleanly into cloudsql/gcs/pubsub/secrets. If a new class earns its own key, create it via `modules/kms/` and migrate consumers; don't keep piling into the general key forever.

## Rotation and key-material lifecycle

**90-day automatic rotation** on every key:

- At the cadence, GCP KMS mints a new primary version. New encryption operations use the new version automatically.
- Existing ciphertext encrypted with older versions remains decryptable — GCP retains every non-destroyed version for decrypt operations. Applications make no code changes.
- **Rotation does NOT re-encrypt existing ciphertext.** That's a separate operation (`google_kms_crypto_key_version` destroy + application re-write) and is deferred unless a compromise is suspected. In Phase 1 we do not run re-encryption drills.

Consequence: over time, keys accumulate versions (~4/year per key = 68 versions across 17 keys per year). Version pruning is out of scope for Phase 1 — GCP doesn't charge per inactive version and there's no security benefit to pruning unless a specific version is suspected compromised. Revisit when OB02 (FinOps) shows version storage as material, or when a compromise scenario needs scoped rotation.

**Manual rotation** can be triggered per-key without waiting for the 90-day cadence (`gcloud kms keys versions create --key=... --keyring=... --location=...`). Useful for incidents or when an engineer with key-access offboards with potential exposure.

## Per-service CMEK grant pattern

Cross-reference: **ADR-INFRA-002 Quirk 5** documents this pattern fully. Brief recap for context here:

Each GCP service that _consumes_ CMEK needs its service agent granted `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the specific CMEK key. API enablement materializes the service agent; the IAM grant is separate and must be explicit.

Pattern:

- **Service-agent email is deterministic:** `service-<project-number>@<service-domain>.iam.gserviceaccount.com`. Compute via `data.google_project.current.number` — don't use `google_project_service_identity` (null-email quirk; see INFRA-002 Quirk 1).
- **Grant lives in the consuming environment's root module**, not bootstrap. Bootstrap owns the keyring + key primitives; envs own their service-agent grants.
- **Demonstrated** in `environments/shared/main.tf` for Artifact Registry. **Replicate** for Cloud SQL (`sqladmin`), Pub/Sub (`pubsub`), Secret Manager (`secretmanager`), GKE, Cloud Run, etc. as those services are introduced in later prompts.

## Rationale

### Where Google-managed encryption alone would have won (and why we chose differently)

Simpler. Zero keys to manage, zero rotation cadence, zero IAM binding maintenance, zero provider quirks. Accepted as real — Google-managed is the baseline default and works fine for a non-enterprise platform.

Rejected because:

- Enterprise-tier DPAs explicitly require customer-managed keys. Google-managed fails the letter of the clause.
- No revocation-as-kill-switch. If a tenant leaves and demands cryptographic erasure, Google-managed gives us no mechanism — we'd have to scan and delete. CMEK gives us a revoke-access-to-key operation that renders data inert with one IAM change.
- SOC 2 auditors specifically ask about CMEK; "we use Google-managed" is a question-continuation answer, not a question-ending answer.

### Where single-key-per-project would have won (and why we chose differently)

4 total keys (3 envs + shared + tfstate). 75% fewer IAM bindings, simpler rotation cadence (one key to rotate per env per 90 days).

Rejected because:

- Surgical rotation is impossible. "Rotate the Cloud SQL key after an engineer with database access offboarded" becomes "rotate everything in the env" — which is operationally noisy and gives the rotation its own risk profile.
- Blast-radius containment is weaker. A single compromised key exposes every data class in the project.
- Auditors score per-resource-class keys higher than single-project keys on sophistication. Reviewing that difference costs more than the ~13 extra keys cost to operate.

### Where per-tenant keys immediately would have won

Long-term the right direction for an Enterprise multi-tenant SaaS. Enables per-tenant kill-switch, per-tenant rotation, per-tenant compliance boundaries.

Rejected for Phase 1 because:

- One tenant (Display Data). The optionality isn't worth the architectural cost yet.
- Data model (D01) needs tenant_id-to-key binding in every CMEK-consuming write path. That's a Phase 2 refinement, not a Phase 0 choice.
- The Phase 1 posture does not preclude per-tenant keys — they're layered on top. Adding a per-tenant key is creating a new key, adding a tenant_id → key_id binding in F01, and updating D06 write paths to reference the tenant's key. No rework of existing infrastructure.

### Where HSM (FIPS 140-2 L3) for everything would have won

Strongest regulatory posture. Satisfies FIPS 140-2 Level 3 requirements (tamper-evident hardware, role-based authentication). Enterprise buyers with federal-government tenants specifically ask for it.

Rejected for Phase 1 because:

- ~5x cost per key per month. At 17 keys, that's meaningful for a pre-revenue stage.
- Dev and staging don't hold production data; HSM on them is cost without regulatory benefit.
- Prod-only HSM upgrade is scheduled (P11.4). Fully pay for the cost when it actually matters (when prod holds Display Data's real POS + imagery data).

### What this decision is NOT

- NOT a commitment to CMEK-for-everything forever. If a specific compliance driver demands stricter posture (HSM-on-all, external-key-manager integration via Cloud EKM), the key class model is additive — add HSM variants alongside SOFTWARE variants, migrate consumers, retire SOFTWARE.
- NOT the tenant-isolation story. Tenant isolation is application-layer (F01 RLS, AC01 policies, D06 storage scoping). CMEK gives environment-level encryption isolation; tenant-level encryption arrives when per-tenant keys do, in Phase 2+.
- NOT a complete rotation story. 90-day automatic rotation covers cadence; manual rotation for incidents is documented but not automated. Incident-triggered rotation workflows (e.g., "when engineer X offboards, auto-rotate keys they had access to") are a future hardening item.

## Consequences

### Positive

- **Enterprise-tier ready posture.** CMEK on every CMEK-capable resource, customer-managed, rotating automatically — the answer to "what's your encryption posture?" is one sentence.
- **Key-class-scoped blast radius.** A compromised `cortex-secrets-key` in dev doesn't touch GCS or Cloud SQL data; a suspected Cloud SQL issue rotates one key, not five.
- **Revocation-as-kill-switch available.** Tenant-offboarding cryptographic erasure is possible today at the _environment_ level (revoke the env keyring's access), and will be possible at the _tenant_ level when per-tenant keys land in Phase 2+.
- **Audit-friendly.** "17 keys, one keyring per project, 90-day rotation, SOFTWARE Phase 1 → HSM prod at P11.4" is a clean story.
- **Additive evolution.** Per-tenant keys, HSM upgrades, additional key classes all add to this plan without replacing it.

### Negative

- **17 keys to operate.** KMS-key overhead at Phase 1 volumes (~2 versions/key, minimal storage) is ~₹500/month total. Acceptable, but non-zero.
- **Per-service CMEK grant pattern is operational overhead.** Every new CMEK-consuming service (Cloud SQL, Pub/Sub, Secret Manager, etc.) requires its service-agent grant in the consuming env's main.tf. Documented in INFRA-002 Quirk 5; pattern is mechanical but not free.
- **HSM upgrade at P11.4 is non-trivial.** Not an in-place upgrade — requires parallel HSM keys, re-encryption of ciphertext, old-key deprecation. Adds ~₹2,500/month for prod post-upgrade. Implementation notes section covers scope.
- **Rotation accumulates key versions.** ~68 versions per year across 17 keys. Pruning is out of scope for Phase 1; revisit when OB02 flags materiality.

### Neutral

- **Default Google-managed encryption still exists** for resources that don't support CMEK (some metadata, some logs, Terraform state file _headers_ — the state data itself is CMEK-encrypted via the bucket's default_kms_key). This is industry norm; not a hole.
- **17 keys sounds like a lot** compared to a 4-key "single per project" posture — but the per-class separation is the reason auditors and buyers rate CMEK postures highly. The cost is the point.

## Alternatives considered

### Alternative 1: Google-managed encryption only

Rejected. Fails Enterprise tier DPA clauses; no revocation-as-kill-switch; SOC 2 auditors flag as weak posture.

### Alternative 2: Single key per project (4 keys total)

Rejected. See Rationale. Surgical rotation impossible, blast radius wider, auditor signal weaker.

### Alternative 3: Per-tenant keys immediately

Rejected for Phase 1. Right direction long-term; premature at 1 tenant. Deferred to Phase 2+ as an additive change.

### Alternative 4: HSM (FIPS 140-2 L3) for every key

Rejected for Phase 1. ~5× cost; dev/staging don't need it; prod HSM scheduled at P11.4 when Display Data data lands.

### Alternative 5: Cross-project or shared keyring

Rejected. Couples environments; deleting a key for compliance in one env would affect others. Per-project keyrings maintain isolation.

### Alternative 6: Cloud EKM (external key management)

Not evaluated for Phase 1. Revisit if a client specifically demands key material held outside GCP (e.g., in their own HSM). Additive — can coexist with CMEK for other tenants.

## Implementation pattern

```
sevyn8-cortex-dev
  └── keyring: cortex-keyring (asia-south1)
      ├── cortex-cloudsql-key        → Cloud SQL (P0.4+)
      ├── cortex-gcs-key             → GCS buckets
      ├── cortex-pubsub-key          → Pub/Sub topics
      ├── cortex-secrets-key         → Secret Manager
      └── cortex-general-key         → catch-all

sevyn8-cortex-staging                  (same 5-key structure as dev)
sevyn8-cortex-prod                     (same 5-key structure; HSM upgrade at P11.4)

sevyn8-cortex-tfstate
  └── keyring: cortex-tfstate-keyring (asia-south1)
      └── cortex-tfstate-key         → state bucket (cortex-tfstate-5402eb)

sevyn8-cortex-shared
  └── keyring: cortex-keyring (asia-south1)
      └── cortex-artifactregistry-key → AR repos (cortex-apps, agents, mcp)

Every key:
  algorithm        = GOOGLE_SYMMETRIC_ENCRYPTION
  purpose          = ENCRYPT_DECRYPT
  protection_level = SOFTWARE            (Phase 1)
  rotation_period  = 7776000s            (90 days)
  lifecycle        = prevent_destroy
```

Creation is bootstrap-owned (`infra/terraform/bootstrap/main.tf`). Referenced elsewhere by fully-qualified resource ID.

## Implementation notes

1. **Per-service CMEK grants.** Documented fully in ADR-INFRA-002 Quirk 5. Brief recap: each CMEK-consuming service's agent needs `cryptoKeyEncrypterDecrypter` on the specific key. Pattern: deterministic email (`service-<project-number>@<service-domain>.iam.gserviceaccount.com`), grant lives in the consuming env's root module, not bootstrap.

2. **Bootstrap-owned keyrings and keys.** Created once in `infra/terraform/bootstrap/`. Referenced elsewhere by fully-qualified name (`projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>`). Do **not** re-create in env modules — bootstrap is the single source of truth for all 17 keys.

3. **Key destruction protection.** Every key has `lifecycle { prevent_destroy = true }` at the Terraform layer. GCP's 24-hour scheduled-destruction window (default) is the second safety layer. Destroying a key requires (a) removing `prevent_destroy` in code, (b) running `terraform destroy` on the specific resource, (c) waiting 24 hours, (d) confirming destruction. This friction is intentional — key destruction is the most-dangerous operation in the platform.

4. **Cross-project key access.** None configured. If a future requirement emerges (a shared service decrypting data from multiple envs), add a narrow `google_kms_crypto_key_iam_member` grant on the specific key for the specific service agent. Do not open keyrings cross-project.

5. **P11.4 HSM upgrade plan — prod only.**

   Trigger: 4 weeks before Display Data production data migration begins. Earlier if any Enterprise DPA explicitly requires FIPS 140-2 L3 (HSM-backed) key material before signing.

   Scope: prod keys only (inventory rows #11–15). Dev and staging remain on SOFTWARE indefinitely — cost of HSM for non-prod is unjustified and doesn't serve any compliance requirement.

   SOFTWARE keys cannot be upgraded in place to HSM. Each resource class has different re-encryption mechanics; the migration is not uniform. Plan per resource class:

   **Phase A — Provision (1-2 days, no data impact):**
   - Create parallel HSM keyring `cortex-hsm-keyring` in `sevyn8-cortex-prod` via a new bootstrap Terraform change
   - Populate 5 HSM keys mirroring the SOFTWARE key set: `cortex-cloudsql-key-hsm`, `cortex-gcs-key-hsm`, `cortex-pubsub-key-hsm`, `cortex-secrets-key-hsm`, `cortex-general-key-hsm`
   - Grant each consuming service's service agent `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the new HSM keys (per ADR-INFRA-002 Quirk 5 pattern)
   - Both SOFTWARE and HSM keys exist in parallel — no consumer references HSM yet

   **Phase B — Resource-class migration (sequenced, ~2-4 weeks):**

   _Cloud SQL (hardest, schedule first):_
   - Cloud SQL CMEK is fixed at instance creation. Migration requires creating a new instance encrypted with HSM key, then data-migrating.
   - Options: (1) read replica promotion with brief failover window (~minutes of downtime), (2) logical export/import (hours of downtime), (3) pg_dump/pg_restore with application cutover.
   - Recommended: option 1 (read replica promotion). Scope a dedicated P11.4.A sub-prompt for this specifically.

   _Secret Manager (medium):_
   - Existing secret versions retain original SOFTWARE key encryption; new versions use HSM.
   - Create new versions of every secret (values unchanged — just re-create the version); consumers auto-promote to `:latest`.
   - Retire old versions after validation.
   - Scope: ~30-50 secrets by Phase 2. Automatable via a migration script.

   _GCS buckets (long-running but non-blocking):_
   - Change bucket `default_kms_key_name` to HSM key — future writes use HSM.
   - Existing objects retain SOFTWARE key encryption until rewritten.
   - Batch rewrite using `gcloud storage cp --recursive` (copies with new encryption) or `gcloud storage rewrite` (in-place).
   - Can run in background over days. Monitor progress via GCS audit logs.

   _Pub/Sub topics:_
   - Change topic CMEK to HSM key — new messages use HSM.
   - In-flight messages decrypt fine with old key. No active migration.
   - Safe to do immediately after Phase A.

   _Artifact Registry (shared project, different scope):_
   - Not in prod project — lives in `sevyn8-cortex-shared`. HSM upgrade for AR is a separate decision and not triggered by prod go-live.
   - Defer to when enterprise DPA explicitly scopes container image storage (rare — most DPAs focus on tenant data, not artifact storage).

   **Phase C — SOFTWARE key deprecation (30-day safety window):**
   - After all resource classes have migrated and stable on HSM keys, disable the SOFTWARE key versions (don't destroy yet — disabled keys cannot encrypt/decrypt but retain material for emergency re-enable).
   - Monitor for 30 days. Any undiscovered reliance on SOFTWARE keys surfaces as decryption failures.
   - After 30 days clean, schedule key version destruction. GCP enforces a 24-hour destruction delay — after that, key material is irrecoverable.
   - SOFTWARE keyring itself kept in-place (empty of active versions) until a follow-up cleanup prompt formally removes it.

   **Phase D — Terraform state reconciliation:**
   - Update bootstrap's `locals.projects.prod.keyring_name` or add HSM keyring alongside
   - Update env/prod module to reference HSM key names
   - `terraform plan` should show zero changes post-migration (if it does, there's drift)
   - Commit the bootstrap + env/prod changes together

   This is operationally significant. Scope a dedicated P11.4 sub-prompt with its own detailed plan, runbook, and rollback procedure before starting Phase B.

6. **State-bucket CMEK ordering.** The tfstate GCS service agent must hold `cryptoKeyEncrypterDecrypter` on `cortex-tfstate-key` _before_ the state bucket is created. Bootstrap handles this with an explicit `depends_on` chain; documented in INFRA-002 Quirk 1 (which led to the data-source approach for the service-agent email lookup).

## Revisit triggers

This decision should be revisited if any of the following happen:

- **First Enterprise-tier DPA requires HSM before prod go-live.** Accelerate the P11.4 HSM upgrade; fold the migration into a dedicated pre-go-live runbook.
- **First tenant offboarding scenario requiring cryptographic erasure per-tenant.** Implement per-tenant CMEK as a Phase 2+ item. Architecture is additive — new keys, new F01 bindings, no re-key of existing infrastructure.
- **Regulatory change specifying encryption key management standards** — e.g., DPDP amendments, a new sectoral regulation, or client-jurisdiction rules (EU GDPR-specific tenant, US federal tenant). Evaluate whether SOFTWARE Phase 1 still passes; adjust rotation cadence, protection level, or both.
- **Rotation cadence pressure.** Phase 1 default is 90 days. If a compliance driver demands shorter (30 or 60), change the `rotation_period` in `modules/kms/variables.tf` default; Terraform re-applies cleanly. Longer cadence would require an ADR supplement explaining why.
- **KMS cost materiality.** OB02 FinOps observability surfaces per-resource-class spend. If KMS costs (keys + version storage) exceed ~1% of infrastructure cost, investigate — likely culprit is excessive rotations or runaway version accumulation, both solvable before wholesale revisit.
- **Cloud EKM demand.** A client requires key material held outside GCP (in their own HSM or Cloud EKM partner). Additive — configure Cloud EKM for that tenant's keys alongside existing CMEK for others.

## References

- Cortex v2.2 Spec §6 Security & Compliance
- ADR-INFRA-001 — Event bus choice (companion)
- ADR-INFRA-002 — Terraform bootstrap (companion; Quirk 5 documents per-service CMEK grant pattern)
- ADR-INFRA-003 — VPC topology (companion)
- P0.3 build prompt (cortex_build_prompts_v3.md §P0.3)
- GCP KMS key rotation — https://cloud.google.com/kms/docs/rotating-keys
- GCP CMEK-compatible services — https://cloud.google.com/kms/docs/using-other-products
- DPDP 2023 text, §8 (Reasonable security safeguards)
- SOC 2 Trust Services Criteria, CC6.1 (encryption of data at rest)
- `infra/terraform/bootstrap/main.tf` — the 17-key inventory as code
- `infra/terraform/modules/kms/` — reusable pattern for future narrow-scope keyrings

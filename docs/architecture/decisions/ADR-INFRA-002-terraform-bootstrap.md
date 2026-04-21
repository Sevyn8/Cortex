# ADR-INFRA-002: Terraform Bootstrap — SA Impersonation via Admin Group, No JSON Keys

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2.2 Spec §3 Infrastructure & Deployment, §6 Security & Compliance; P0.3 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-003 (VPC topology), ADR-INFRA-004 (CMEK key hierarchy)

---

## Context

The Cortex infrastructure is managed exclusively in Terraform. Before any Terraform can run, four things have to exist:

1. An identity to authenticate as when creating resources
2. A place to store state (to avoid resource drift across runs)
3. Encryption for that state (Enterprise-tier compliance posture)
4. A way for operators to gain and revoke authority to run infrastructure changes

**This is the foundational infrastructure ADR.** Every subsequent environment and module prompt inherits decisions made here — state-bucket naming, SA names, IAM patterns, the relationship between personal credentials and Terraform identity. If any of these change, a lot of downstream code changes with them.

Three forcing functions shape the specific choice:

1. **Team size is small (2–3 operators).** Onboarding has to be a single-step action ("get added to cortex-admins"), not a credential provisioning workflow. At the same time, offboarding must be instantaneous — the mechanism that gates authority must be something a group-admin can revoke in seconds.

2. **Sevyn8 targets Enterprise-tier clients.** The DPDP compliance posture, and preparation for SOC 2 Type II, both require: no long-lived downloaded credentials, every credential-bearing action auditable to a specific identity, and key/secret rotation either automatic or well-documented. Downloaded JSON service-account keys fail all three properties.

3. **Local dev AND CI/CD both need to work.** A pattern that only works on a developer's laptop doesn't scale to GitHub Actions deployments in P0.5. A pattern that only works in CI leaves local development reaching into CI pipelines for every test, which is slow and fragile.

The v3 P0.3 prompt scoped authentication to "SA impersonation, no downloaded JSON keys" without specifying which SAs or how the chain bootstraps. That is the design space this ADR closes.

## Decision

**Per-project `cortex-tf-admin` service accounts, impersonated via the `cortex-admins@sevyn8.com` Google Workspace group. A one-shot bootstrap module runs with personal Application Default Credentials (ADC) to establish this chain; everything else runs under SA impersonation against GCS-backed remote state.**

Specifically:

1. **Five SAs, one per project.** `cortex-tf-admin@sevyn8-cortex-{dev,staging,prod,tfstate,shared}.iam.gserviceaccount.com`. Each SA holds `roles/owner` on its own project.

2. **Group binding for impersonation.** `cortex-admins@sevyn8.com` holds `roles/iam.serviceAccountTokenCreator` on each SA. Members of the group use `gcloud auth application-default login` to authenticate locally, then Terraform's `impersonate_service_account` provider attribute mints short-lived tokens via the Token Creator binding.

3. **Bootstrap module.** `infra/terraform/bootstrap/` is a one-shot Terraform root that runs with personal ADC and local state. It creates the 5 SAs, the state bucket (`cortex-tfstate-<suffix>`, CMEK-encrypted, versioned, 30-day soft-delete), the 5 KMS keyrings and 17 keys, and the IAM bindings that let subsequent Terraform runs use SA impersonation instead.

4. **State is remote and per-environment.** Each env root module (`infra/terraform/environments/{dev,staging,prod,shared,tfstate}/`) uses a GCS backend with a distinct prefix under `cortex-tfstate-<suffix>/`. State access goes through `cortex-admins`' direct `storage.objectAdmin` grant on the bucket; resources are created via SA impersonation. Humans own state, SAs own resources.

5. **No JSON key files. Ever.** No `gcloud auth activate-service-account`, no `service-account.json`, no downloaded credentials of any kind. Credential-class files are gitignored by default; repository workflow assumes zero long-lived service-account keys.

6. **GCE instance metadata is not a credential source for operators.** Operator credentials are always derived from personal Google Workspace identity + group membership. Compute-identity-based auth is reserved for workloads (Cloud Run services, future GKE pods) via Workload Identity; it is out of scope for human-operator Terraform.

## Rationale

### Where personal-ADC-throughout would have won (and why we chose differently)

Simpler mental model, no impersonation layer, no Token Creator binding to reason about. Accepted as real — impersonation adds one concept to learn. Rejected because:

- Audit trail shows the operator's personal identity as the actor for every resource change, which is noisy for incident response (engineering staff change, tokens get used cross-machine, identities are not SA-scoped).
- No separation between human and infrastructure identity. A compromised laptop credential has direct infrastructure authority rather than "authority to impersonate a specific SA", which is a weaker security posture than the deploy-scoped one.
- Granular per-env revocation is impossible: you either hold `roles/owner` on a project or you don't. With SAs, cortex-admins membership can be revoked for a specific person without touching project IAM.

### Where downloaded JSON service-account keys would have won (and why we chose differently)

Simpler CI integration (CI needs a credential file). Accepted as real for the CI case — though Workload Identity Federation supersedes it, see P0.5. For local human operators, rejected because:

- Rotation is a manual dance no one does reliably.
- Keys leak through: committed to repos, pasted into chat, shipped in logs. "Secret in a file" has a known failure mode.
- Impossible to audit "who used this key, when, from where" with the same fidelity as impersonation tokens.
- DPDP, SOC 2, and every enterprise security review flag downloaded service-account keys as a posture weakness by default.

### Where Workload Identity Federation (WIF) for human operators would have won

WIF binds cloud credentials to an external identity provider (Google Workspace OIDC, GitHub Actions OIDC, etc.) without any intermediate service-account key. For CI/CD, WIF is the correct pattern and is the P0.5 target.

For local human operators at team size 2–3, WIF adds complexity (pool configuration, provider configuration, workload-identity-pool-based IAM bindings) that the impersonation-via-group pattern already handles. The complexity is paid for by operational scale (hundreds of engineers, stricter compliance), which Sevyn8 does not yet have.

**Deferred, not rejected.** Revisit at team-size-3+ or when a compliance review explicitly requires no personal ADC.

### What this decision is NOT

- NOT a commitment to JSON-key-free CI/CD. P0.5 will use Workload Identity Federation from GitHub Actions to each environment's `cortex-tf-admin` SA — the SA becomes the shared identity, CI gets it via WIF, humans get it via group-based impersonation. Two front doors, one identity.
- NOT a commitment to bootstrap-by-console. Bootstrap is Terraform code, runnable from any `cortex-admins` member's machine with personal ADC.
- NOT a separation-of-duties construct. cortex-admins holds impersonation authority on all environments. Sevyn8 is small; a four-eyes gate at apply time (the `CONFIRM=yes` Makefile guard on prod) is the compensating control. If regulatory requirements later demand real separation (e.g., no single person can both plan and apply to prod), this ADR needs revisiting.

## Consequences

### Positive

- **Onboarding and offboarding are one-step** (add/remove from `cortex-admins@sevyn8.com`). No credential provisioning or revocation workflow.
- **One-identity-per-apply in audit logs.** Cloud Audit Logs show `cortex-tf-admin@<env>` as the actor for every resource change, with operator attribution in the impersonation token's delegation chain.
- **Bootstrap is transparent and code-reviewable.** Every SA, every IAM binding, every KMS grant is Terraform code with a commit history. No "run this console wizard" dark matter.
- **State lives in GCP with enterprise guarantees** (versioning, CMEK, soft-delete, UBLA, public-access prevention). Lost state is recoverable from versions; accidental delete retains 30 days.
- **Compliance posture is defensible today.** No downloaded keys, no long-lived credentials, every action attributable.

### Negative

- **One-time personal-ADC bootstrap step on a human's machine.** Bootstrap state file is gitignored and lives on the operator's laptop. Loss is recoverable via `terraform import` (documented in `infra/terraform/bootstrap/README.md`) but painful. Mitigation: operator backs up `terraform.tfstate` after every bootstrap run.
- **Five provider/role quirks cataloged below.** Each was 30+ minutes of investigation during the P0.3 apply; future Cortex installers benefit from reading them first rather than rediscovering.
- **`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` env var on env-level commands.** Necessary workaround for provider edge cases; baked into the Makefile `tf-plan-*` and `tf-apply-*` targets so operators don't type it.

### Neutral

- **Terraform provider version pin matters.** Impersonation behavior and provider-specific resources (particularly those in Quirks 1 and 2) shift across `hashicorp/google` 5.x → 6.x. Pinned to `~> 6.0` in every module; unpin-and-retest is an ADR-gated change.
- **The bootstrap module is infrastructure-of-infrastructure.** Changes to it have maximum blast radius. Apply only after human review of the plan output. The `lifecycle { prevent_destroy = true }` on KMS keys and the state bucket is the structural guardrail.

## Alternatives considered

### Alternative 1: Personal ADC throughout, no SA impersonation

See rationale above. Rejected on audit, separation, and revocation grounds.

### Alternative 2: Downloaded JSON service-account keys

Rejected on rotation, leak, and compliance grounds. Key files are gitignored and never created by our tooling.

### Alternative 3: Workload Identity Federation for human operators

Deferred to Phase 2+ or when team size grows past ~3 operators. WIF for CI/CD pipelines is the P0.5 target and is explicitly endorsed there.

### Alternative 4: Single god-SA impersonated across all projects

Considered. Rejected because a shared identity collapses audit trails across environments (a prod apply and a dev apply look identical in logs) and removes per-env revocation as a tool. The per-project SA structure costs 4 extra IAM bindings in bootstrap and buys clean separation forever.

### Alternative 5: gcloud-only console/CLI workflow, no Terraform for bootstrap

Considered. Rejected because the bootstrap state (SA emails, KMS key IDs, bucket name) becomes undocumented tribal knowledge. Terraform-managed bootstrap makes all of it reproducible from code.

## Implementation pattern

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Operator laptop                                                          │
│                                                                          │
│   1. gcloud auth application-default login                              │
│      → Personal ADC (amit@sevyn8.com, member of cortex-admins)          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │  Only for bootstrap (one-shot) — personal ADC
                                │  creates state bucket + SAs + KMS directly.
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GCP — bootstrap artifacts                                                │
│                                                                          │
│   sevyn8-cortex-tfstate/ — state bucket, CMEK                           │
│   sevyn8-cortex-{dev,staging,prod,shared,tfstate}/ — SAs, keyrings      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │  After bootstrap — every subsequent apply
                                │  impersonates cortex-tf-admin@<env>.
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Operator laptop (subsequent runs)                                        │
│                                                                          │
│   make tf-plan-dev / tf-apply-dev                                        │
│   → Personal ADC calls iamcredentials.generateAccessToken               │
│     on cortex-tf-admin@sevyn8-cortex-dev (via group tokenCreator)       │
│   → Short-lived token authorizes all provider operations                │
│   → State read/write uses personal ADC directly (group has bucket       │
│     objectAdmin) — humans own state, SAs own resources                  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Implementation notes

Five quirks surfaced during the P0.3 apply. These are **the real cost of the decision** — not the design itself, but the specific points where Terraform, GCP, or provider behavior diverges from expectation. Future Cortex installers will hit all five; future modules that introduce new GCP services will probably add a sixth. This section exists to short-circuit the debugging.

### Quirk 1 — `google_project_service_identity` returns null `.email` when service agent pre-exists

In the bootstrap module, the GCS service agent for the tfstate project needed a KMS grant for state-bucket CMEK. Initial attempt used `google_project_service_identity` (google-beta) to materialize the agent and reference its `.email`. The resource returns `.email = null` when the service agent already existed in the project pre-Terraform (known google-beta provider quirk).

**Resolution:** replaced with `data "google_storage_project_service_account"`, which performs a direct API lookup and is robust whether the agent pre-existed or not.

**State cleanup:** `terraform state rm google_project_service_identity.gcs_tfstate` — the underlying service agent persists in GCP (agents cannot be deleted via API).

**Pattern for future modules:** for any service-agent email _lookup_, prefer the service-specific data source (e.g., `google_storage_project_service_account`) or compute the email deterministically from project number (see Quirk 5). Avoid reading `.email` from `google_project_service_identity` — that output is unreliable when the agent pre-existed. Using the resource purely as a materialization trigger for services whose agent must be force-created in a fresh project — without consuming its outputs — is a separate, valid pattern (see ADR-INFRA-005 Quirk 1).

### Quirk 2 — `google_service_networking_connection` first-apply race

`google_service_networking_connection` has a known first-apply race with Service Networking API service-agent propagation in newly-enabled projects. First apply typically fails with a misleading "invalid authentication credentials" error; retry after 30–60s succeeds.

The `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` env var is still required for this resource (covers the actual impersonation-bypass case), but it doesn't prevent the first-apply flakiness. Observed 2 of 3 environments in P0.3 (dev and staging hit it; prod succeeded on first apply).

**Treat retry as expected-maybe, not required.** The Makefile `tf-apply-<env>` targets set the env var; operators re-run the apply if the first attempt hits the race.

**Pattern for future modules:** any module that adds a `google_service_networking_connection`-class resource (PSA peerings, new service-networking integrations) will inherit this race. Document the retry expectation in the module's README.

### Quirk 3 — `roles/owner` excludes IAM v2 permissions

`roles/owner` does not include `iam.googleapis.com/denypolicies.create` or other IAM v2 permissions. IAM v2 was designed with stricter access boundaries; v2 permissions are intentionally carved out of the legacy primitive roles.

**Pattern:** any time a module uses a newer IAM v2 API (Principal Access Boundary, Workload Identity Pools v2, future v2 features), grant the v2-specific admin role explicitly. Do not assume `roles/owner` covers it.

This quirk surfaced when attempting to create env-level deny policies; see Quirk 4.

### Quirk 4 — `roles/iam.denyAdmin` not grantable at project level

`roles/iam.denyAdmin` is only grantable at organization or folder level, not project level. The role governs IAM v2 deny-policy creation. Attempting to bind it at project scope fails with `Role roles/iam.denyAdmin is not supported for this resource`.

In Phase 1, `cortex-admins@sevyn8.com` does not hold org-admin on sevyn8.com, so env-level deny policies are deferred.

**Phase 1 posture:** implicit deny via role design (`roles/viewer` excludes `secretmanager.*`). P0.5 adds a CI-check validating that `cortex-observer`'s effective permissions include zero `secretmanager.*` verbs. Phase 2+ coordinates the org-level `denyAdmin` grant.

**Pattern for future modules:** before adding any `google_iam_deny_policy` resource, confirm that the Terraform identity holds `roles/iam.denyAdmin` at a scope (org or folder) that covers the project. For Phase 1, do not add deny policies.

### Quirk 5 — CMEK service-agent grants live in the consuming environment

Each GCP service that consumes CMEK requires a grant of `roles/cloudkms.cryptoKeyEncrypterDecrypter` to its service agent on the specific CMEK key. API enablement materializes the agent; the IAM grant is separate and must be explicit.

**Pattern:** compute the service-agent email deterministically from project number (`service-<project-number>@<service-domain>.iam.gserviceaccount.com`). Grant lives in the consuming environment's root module, NOT bootstrap. Rationale: bootstrap is for root-of-trust primitives only; each env owns its service-agent CMEK grants.

Pattern demonstrated in `environments/shared/main.tf` for Artifact Registry:

```hcl
resource "google_kms_crypto_key_iam_member" "artifactregistry_cmek" {
  crypto_key_id = var.kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-artifactregistry.iam.gserviceaccount.com"
  depends_on    = [module.project_baseline]
}
```

Replicate for Cloud SQL (`sqladmin`), Pub/Sub (`pubsub`), Secret Manager (`secretmanager`), etc. **Do not read `.email` from `google_project_service_identity`** due to the null-email quirk (see Quirk 1); compute the member string deterministically from project number instead. The resource itself may still be used as a pure materialization trigger — see ADR-INFRA-005 Quirk 1 for the Cloud SQL example where the agent is not materialized at all until first use.

## Revisit triggers

This decision should be revisited if any of the following happen:

- **GCP changes any of the 5 documented quirks** — e.g., fixes `google_project_service_identity` null-email behavior, eliminates the Service Networking first-apply race, extends `roles/owner` to include IAM v2 permissions, or makes `roles/iam.denyAdmin` grantable at project level. Each resolution removes its corresponding workaround from the Cortex codebase.
- **Team size grows beyond ~3 engineers actively doing infra work** — at that point, Workload Identity Federation for human operators becomes worth the complexity investment, and the per-person SA impersonation pattern becomes unwieldy.
- **Compliance audit explicitly requires no human-level cloud credentials at all** — would force WIF-for-humans (OIDC from Google Workspace) regardless of team size. Document audit requirement, implement, retire personal-ADC bootstrap.
- **A Cortex client requires on-prem or non-GCP deployment** — bootstrap assumes GCS-backed state. Non-GCP targets need an equivalent bootstrap for their object store (e.g., S3 + AWS KMS). The abstraction at play is "project / keyring / key / bucket" — portable in principle, new code in practice.
- **Separation of duties is imposed by regulation** — current posture is group-based; no role fence between plan and apply. If audit requires two-person control, a separate `cortex-plan` SA and a `cortex-apply` SA with human approval in between becomes the pattern.

## References

- Cortex v2.2 Spec §3 Infrastructure & Deployment, §6 Security & Compliance
- ADR-INFRA-001 — Event bus choice (companion infra ADR)
- ADR-INFRA-003 — VPC topology (companion infra ADR)
- ADR-INFRA-004 — CMEK key hierarchy (companion infra ADR; cross-references Quirk 5)
- P0.3 build prompt (cortex_build_prompts_v3.md §P0.3) — the operational requirements
- `infra/terraform/bootstrap/README.md` — bootstrap run sequence + recovery procedure
- `docs/runbooks/infrastructure.md` — day-to-day Terraform workflow
- Google Cloud IAM v2 documentation — https://cloud.google.com/iam/docs/deny-overview
- Terraform GCS backend docs — https://developer.hashicorp.com/terraform/language/settings/backends/gcs
- Terraform `hashicorp/google` provider v6 — https://registry.terraform.io/providers/hashicorp/google/latest/docs

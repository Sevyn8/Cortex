# Terraform - conventions, workflow, IAM gotchas

> Relocated from CLAUDE.md for context-budget; loaded on demand.

## Terraform conventions

- Format with `terraform fmt -recursive` before commit.
- 2-space indent. Align equals within a block where it improves readability.
- Resource names: snake*case (`google_compute_network.cortex_vpc`). Resource-name \_values* follow GCP naming (hyphens).
- File layout per root/module: `providers.tf`, `versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`, `locals.tf` (when 3+ locals).
- Version pins: Terraform `~> 1.14.0`; `hashicorp/google ~> 6.0`, `hashicorp/google-beta ~> 6.0`, `hashicorp/random ~> 3.6`.
- Every `variable` has `type` and `description`. `default` only when truly defaultable.
- Every `output` has a `description`.
- Module source paths use local relative paths (`../../modules/...`), not registry URLs.
- Use `moved { ... }` blocks for resource renames - avoids destroy + recreate.
- Prefer explicit resource declarations when item count is small and stable (e.g., 4 firewall rules as 4 blocks).
- Use `for_each` for dynamic-count collections (API enablement, cartesian IAM bindings).
- Use `data` sources for existing-resource attribute lookups (project numbers, service-agent emails). Avoid `terraform import` unless deliberately adopting a resource into Terraform management.
- Prefer `google_*_iam_member` (additive). Never use `google_*_iam_policy` or `google_*_iam_binding` (authoritative - overwrites existing bindings).
- IAM member prefixes: `serviceAccount:`, `group:`, `user:`, `principal://` (deny-policy v2).
- `lifecycle { prevent_destroy = true }` on KMS keys and state buckets.
- No downloaded JSON keys. SA impersonation only.
- Resource labels: `managed_by = "terraform"`, `project = "cortex"`, `environment = "<env>"`, `prompt = "<creation-prompt-id>"`.
- Each root module's state owns its own resources. No cross-state ownership.
- See ADR-INFRA-002, -003, -004 in `/docs/architecture/decisions/`.

## Terraform workflow

- Plan before apply, always. Never apply without reviewing the diff.
- `terraform apply <planfile>` is the apply shape used after review. `terraform apply -auto-approve` without a saved plan file is forbidden.
- Never create infrastructure via GCP Console. If it isn't in Terraform, it doesn't exist.
- Use the Makefile `tf-*` targets for all env operations. They bake in `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` and the prod gate.
- Prod applies require `CONFIRM=yes`: `make CONFIRM=yes tf-apply-prod`.
- After any apply, re-run `tf-plan-<env>` to verify idempotency. A non-empty re-plan is drift - investigate before anything else.
- Commit Terraform code changes that drove an apply alongside related app-level changes where possible, so the "what happened" is one `git log` entry.
- See `/docs/runbooks/infrastructure.md` for day-to-day operations.

## IAM gotchas

- **"Request had invalid authentication credentials" on first apply of `google_service_networking_connection`** - PSA service-agent propagation race in newly-enabled projects; retry after 30–60s. See ADR-INFRA-002 Quirk 2.
- **"Role roles/iam.denyAdmin is not supported for this resource"** - only grantable at org/folder level, not project. Phase 1 defers env-level deny policies; rely on implicit deny via role design. See ADR-INFRA-002 Quirk 4.
- **`iam.googleapis.com/denypolicies.create` (or other IAM v2 permission) denied despite SA holding `roles/owner`** - IAM v2 permissions are carved out of legacy `roles/owner`. Grant the v2-specific admin role explicitly. See ADR-INFRA-002 Quirk 3.
- **CMEK-requiring resource creation fails with "permission denied" on the key** - the service's service agent needs `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the specific CMEK key. Compute email deterministically from project number; grant lives in the consuming env module, not bootstrap. See ADR-INFRA-002 Quirk 5.
- **`google_project_service_identity` returns `.email = null`** - provider quirk when the service agent was materialized pre-Terraform. Use `data "google_storage_project_service_account"` (or equivalent service-specific data source) instead. See ADR-INFRA-002 Quirk 1.
- **"Service account service-\<N\>@gcp-sa-cloud-sql.iam.gserviceaccount.com does not exist" on first Cloud SQL CMEK grant** - Cloud SQL service agent is materialized lazily on first use, not at API-enable time; and IAM propagation of the agent's existence lags its creation by ~30-60s. Add `google_project_service_identity` (google-beta) + a `time_sleep` of 60s before any IAM grant targeting the agent in a fresh project. See ADR-INFRA-005 Quirk 1.

# ci-runner — Cloud Build migration runner (per env)

Provisions the per-env identity + compute substrate for the Cloud Build
migration runner: a submit/worker service-account pair, the IAM bindings
between them and the Cloud Build service agent, and a private worker pool
peered to the env VPC. Per ADR-CI-001 + ADR-INFRA-006 Decisions 4–5.

## What this module creates

- `google_service_account.submit` — `cortex-ci-submit-{env}`. Receives WIF binding from the env root; submits Cloud Build jobs. Roles: `cloudbuild.builds.editor` (project), `iam.serviceAccountUser` on the worker.
- `google_service_account.worker` — `cortex-ci-migration-{env}`. Cloud Build runs as this identity. Roles: `cloudsql.client` (project), `secretmanager.secretAccessor` (scoped to break-glass secret).
- `google_service_account_iam_member.cloudbuild_token_creator_on_worker` — Cloud Build service agent gets `serviceAccountTokenCreator` on the worker (required for runtime impersonation; NOT implicit via `cloudbuild.serviceAgent`).
- `google_project_service_identity.cloudbuild` (google-beta) + `time_sleep` — eager materialization of the Cloud Build service agent on fresh projects (60s wait for IAM propagation).
- `google_cloudbuild_worker_pool.cortex_migration_runner` — private worker pool peered to the env VPC.

## What this module does NOT create

- `roles/iam.workloadIdentityUser` binding on the submit SA — wired in the env root using outputs from this module + the `wif` module. Cross-module wiring lives at the root.
- The Cloud Build PSA range — created by the `networking` module; this module consumes the CIDR via `cloudbuild_psa_range_cidr`.
- The break-glass Secret Manager secret — created by P0.4 setup; this module references it by ID.

## Inputs

| Variable                    | Required | Default                   | Description                                                                            |
| --------------------------- | -------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `project_id`                | yes      | —                         | Env GCP project (`sevyn8-cortex-{env}`).                                               |
| `environment`               | yes      | —                         | `dev` \| `staging` \| `prod`.                                                          |
| `vpc_id`                    | yes      | —                         | Self-link of `cortex-vpc` from the networking module.                                  |
| `cloudbuild_psa_range_cidr` | yes      | —                         | CIDR of the Cloud Build PSA range from the networking module (e.g., `10.10.224.0/24`). |
| `break_glass_secret_id`     | yes      | —                         | Short ID of `cortex-db-postgres-break-glass-{env}` for scoping `secretAccessor`.       |
| `region`                    | no       | `asia-south1`             | Worker pool region. Must match VPC region.                                             |
| `worker_pool_machine_type`  | no       | `e2-medium`               | Pool machine type.                                                                     |
| `worker_pool_id`            | no       | `cortex-migration-runner` | Pool short ID.                                                                         |

## Outputs

| Output                      | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `submit_sa_email`           | Pass to `google-github-actions/auth` in workflow.     |
| `submit_sa_resource_name`   | Used by env root for `workloadIdentityUser` binding.  |
| `worker_sa_email`           | Pass to `gcloud builds submit --service-account=...`. |
| `worker_sa_resource_name`   | For cross-state and audit references.                 |
| `worker_pool_resource_name` | Full pool path; reference in `migrate.yaml` options.  |
| `worker_pool_id`            | Short pool ID.                                        |

## Usage (env root example)

```hcl
module "ci_runner" {
  source = "../../modules/ci-runner"

  project_id                = var.project_id
  environment               = "staging"
  vpc_id                    = module.networking.vpc_self_link
  cloudbuild_psa_range_cidr = module.networking.cloudbuild_psa_range_cidr
  break_glass_secret_id     = "cortex-db-postgres-break-glass-staging"
}

# WIF binding wired at root using outputs from this module + the wif pool name
# (hard-coded in tfvars per ADR-INFRA-006 Decision 8).
resource "google_service_account_iam_member" "wif_submit_staging" {
  service_account_id = module.ci_runner.submit_sa_resource_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${var.wif_pool_resource_name}/attribute.workflow_ref/rahul-1974/Cortex/.github/workflows/migrate-staging.yaml@refs/heads/main"
}
```

## Notes

- **First-apply lead time.** Cloud Build private worker pools take 5–10 minutes to provision on first creation (GCP-side tenant project + PSA peering setup). Subsequent updates are fast. See ADR-CI-001 Impl Notes "Private pool provisioning lead time."
- **IAM propagation.** Both the `serviceAccountTokenCreator` binding on the worker SA and the `workloadIdentityUser` binding (created at root) take ~30–60s to propagate. First run after Terraform lands may fail with `Permission ... denied`. Wait + retry. Same pattern as ADR-INFRA-002 Quirk 1.
- **Cloud Build service agent eager materialization.** This module includes the `google_project_service_identity` + `time_sleep` pair so the `serviceAccountTokenCreator` binding succeeds on fresh projects where the agent hasn't been created yet. Same pattern as the cloud-sql module (ADR-INFRA-005 Quirk 1).

See ADR-CI-001 (Cloud Build migration runner pattern) and ADR-INFRA-006 (WIF topology) for the full design.

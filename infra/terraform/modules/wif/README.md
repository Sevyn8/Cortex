# wif — Workload Identity Federation

Provisions a single Google Cloud Workload Identity pool and a GitHub Actions
OIDC provider per ADR-INFRA-006. Outputs the pool resource name and a
principal-set base string for consuming env modules.

## What this module creates

- `google_iam_workload_identity_pool.cortex_github` — the pool (default ID `cortex-github-pool`).
- `google_iam_workload_identity_pool_provider.cortex_github` — the GitHub OIDC provider (default ID `cortex-github-provider`).

The pool has `lifecycle { prevent_destroy = true }` because deleted pools
enter a 30-day soft-delete state during which the pool ID cannot be reused.
The provider can be recreated freely; only the pool is locked.

## What this module does NOT create

- Service accounts (live in env or shared roots).
- `roles/iam.workloadIdentityUser` bindings on SAs (per-SA in consuming roots).
- `roles/iam.serviceAccountTokenCreator` bindings (per-SA in consuming env roots).

These are separated because they're per-SA decisions; this module is just the
pool and provider machinery. See ADR-INFRA-006 Decisions 4–5 for the SA
topology.

## Inputs

| Variable                | Required | Default                  | Description                                                                               |
| ----------------------- | -------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `project_id`            | yes      | —                        | GCP project hosting the pool (Cortex: `sevyn8-cortex-shared`).                            |
| `repo_full_name`        | yes      | —                        | GitHub repo as `owner/repo` (Cortex: `rahul-1974/Cortex`). Used in `attribute_condition`. |
| `pool_id`               | no       | `cortex-github-pool`     | Pool short ID.                                                                            |
| `pool_display_name`     | no       | `Cortex GitHub Actions`  | Console display.                                                                          |
| `pool_description`      | no       | (see source)             | Console description.                                                                      |
| `provider_id`           | no       | `cortex-github-provider` | Provider short ID.                                                                        |
| `provider_display_name` | no       | `GitHub Actions OIDC`    | Console display.                                                                          |

## Outputs

| Output                    | Description                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pool_id`                 | Short pool ID.                                                                                                                       |
| `pool_resource_name`      | Full pool path (`projects/<n>/locations/global/workloadIdentityPools/<id>`); hard-code into env tfvars per ADR-INFRA-006 Decision 8. |
| `pool_principal_set_base` | `principalSet://iam.googleapis.com/<pool-resource-name>`; append `/attribute.<key>/<value>` for per-SA member strings.               |
| `provider_id`             | Short OIDC provider ID.                                                                                                              |
| `provider_resource_name`  | Full provider path; pass as `workload_identity_provider` to `google-github-actions/auth` in workflow files.                          |
| `project_number`          | Pool host project number.                                                                                                            |

## Usage

```hcl
module "wif" {
  source = "../../modules/wif"

  project_id     = var.project_id
  repo_full_name = "rahul-1974/Cortex"
}
```

Per-SA bindings in consuming roots reference the pool via:

```hcl
resource "google_service_account_iam_member" "wif_submit_staging" {
  service_account_id = google_service_account.cortex_ci_submit.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${data.terraform_remote_state.shared.outputs.pool_principal_set_base}/attribute.workflow_ref/rahul-1974/Cortex/.github/workflows/migrate-staging.yaml@refs/heads/main"
}
```

(Or, per ADR-INFRA-006 Decision 8, hard-code the pool resource name into env
`terraform.tfvars` and avoid the cross-state read entirely.)

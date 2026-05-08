# `tenant-cloud-run-service`

Generic Cloud Run service module for Cortex control-plane workloads.
Supports both **shared** (one service per env; STANDARD tenants share)
and **tenant** (one service per ENTERPRISE tenant) deployment shapes per
ADR-COMPUTE-001 + Q-NEW-D-10.

F02 Slice D D.4 wires `mode="shared"` for `tenant-lifecycle-shared`. The
`mode="tenant"` branch is reachable today (`terraform validate`
exercises both shapes) but no env instantiates it until ENTERPRISE
per-tenant deploys land post-ADR-INFRA-005.

## Inputs

See `variables.tf` for the full list with validation rules. Highlights:

| Variable                            | Required             | Notes                                                                         |
| ----------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `mode`                              | yes                  | `"shared"` (Slice D) or `"tenant"` (post-ADR-INFRA-005).                      |
| `workload`                          | yes                  | Short-name; ≤19 chars per ADR-COMPUTE-001 §3 length budget.                   |
| `tenant_id`                         | when `mode="tenant"` | UUID; embedded in service name.                                               |
| `image_uri`                         | yes                  | Fully-qualified Artifact Registry path with SHA tag.                          |
| `runtime_sa_email`                  | yes                  | Per Q-NEW-D-11: same SA serves runtime + Cloud Tasks invoker + OIDC audience. |
| `cloudsql_instance_connection_name` | yes                  | Cloud SQL Auth Proxy mount point.                                             |
| `min_instances`                     | yes                  | Per `tenant-lifecycle-convention.md` §7.1: dev=0, staging=1, prod=1.          |

## Outputs

`service_name`, `service_url`, `service_account_email`, `location`,
`project`. Cross-referenced by env-level main.tf for the D.5 run.invoker
IAM allowlist + monitoring alert policies.

## What this module does NOT do

- Grant `roles/run.invoker` on the service. SD8's deny-by-default floor
  ships here; the per-caller allowlist is **D.5**'s job.
- Create the runtime SA. The SA is created in env-level main.tf (e.g.,
  `tenant-lifecycle-runtime` for the lifecycle workload) before this
  module is instantiated.
- Grant `roles/cloudsql.client` / `roles/cloudsql.instanceUser` on the
  runtime SA. Those bindings live in env-level main.tf — they attach
  to the SA, not the Cloud Run service.
- Manage the deployed image SHA. `lifecycle.ignore_changes` preserves
  the image on `tf-apply` so out-of-band `gcloud run deploy` operations
  during dev iteration don't get reverted. The TF module owns the
  service SHAPE; image deploys are operator-driven via deploy scripts.
  D.6+ tightens this for production.

## Validation pattern

`terraform validate` against a synthetic root that exercises both modes
is the SD9 acceptance gate (planning Risk #2 mitigation):

```hcl
# synthetic-root/main.tf
module "shared_test" {
  source                            = "../infra/terraform/modules/tenant-cloud-run-service"
  project_id                        = "validate-only"
  environment                       = "dev"
  mode                              = "shared"
  workload                          = "tenant-lifecycle"
  image_uri                         = "asia-south1-docker.pkg.dev/x/y/z:sha-abc"
  runtime_sa_email                  = "test@example.iam.gserviceaccount.com"
  cloudsql_instance_connection_name = "p:r:i"
  min_instances                     = 0
}

module "tenant_test" {
  source                            = "../infra/terraform/modules/tenant-cloud-run-service"
  project_id                        = "validate-only"
  environment                       = "prod"
  mode                              = "tenant"
  workload                          = "tenant-lifecycle"
  tenant_id                         = "550e8400-e29b-41d4-a716-446655440000"
  image_uri                         = "asia-south1-docker.pkg.dev/x/y/z:sha-abc"
  runtime_sa_email                  = "test@example.iam.gserviceaccount.com"
  cloudsql_instance_connection_name = "p:r:i"
  min_instances                     = 1
}
```

Both shapes must pass `terraform validate`. Per-env wiring instantiates
only `mode="shared"` until ENTERPRISE swap.

## References

- ADR-COMPUTE-001 — Cloud Run service-name format (shared vs tenant).
- ADR-INFRA-005 Decision 11 — Cloud SQL IAM auth (no PG passwords).
- ADR-INFRA-006 — WIF identity layer (D.5 invoker IAM inherits).
- ADR-LIFECYCLE-001 §3 — Cloud Tasks → Cloud Run OIDC (Q-NEW-D-11
  Option 1: shared SA pattern).
- `docs/architecture/tenant-lifecycle-convention.md` §7.1 — production
  posture lock (min_instances per env).
- `docs/architecture/tenant-lifecycle-convention.md` §7.6 — D.3 HTTP
  surface + the labels-period-free lesson from D.1.
- Planning doc Q-NEW-D-10 (mode shapes) + Q-NEW-D-11 (invoker SA
  decision).

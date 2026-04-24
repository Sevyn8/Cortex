# environments/dev

Cortex dev environment root module.

## What lives here

- Module-specific API enablement (adds 10 APIs on top of bootstrap's 6).
- VPC `cortex-vpc` in `sevyn8-cortex-dev`, CIDR plan 10.10.0.0/16.
- `cortex-observer` service account with `roles/viewer`. No Secret Manager access by role design (`roles/viewer` excludes `secretmanager.*`). Drift detection via CI-check planned for P0.5.

## What does NOT live here

- Cloud SQL, Pub/Sub topics, GKE, Cloud Run — per-module prompts (P0.4 onward).
- KMS keyrings and keys — bootstrap-owned.
- Runtime SAs for specific services — per-module prompts.

## Running

```
make tf-init-dev
make tf-plan-dev
make tf-apply-dev      # confirmation prompt
```

Or directly:

```
cd infra/terraform/environments/dev
terraform init
terraform plan
terraform apply
```

## Local variables (`local.auto.tfvars`)

Some variables live only in a gitignored `local.auto.tfvars` in this directory — personal identities and credentials never commit. Currently required: `notification_recipients` (list of operator contacts) and `chat_webhook_url` (Google Chat incoming webhook). Without this file, `terraform plan` / `apply` will fail fast with "variable X is required but has no default". Get current values from a shared secure channel (secrets manager, 1Password) or another operator; never paste into chat or commit to the repo.

## Identity

- Operators authenticate via personal ADC (`gcloud auth application-default login`) and membership in `cortex-admins@sevyn8.com`.
- State access: personal ADC → the group's `storage.objectAdmin` on the state bucket (see `backend.tf`).
- Resource creation: provider impersonates `cortex-tf-admin@sevyn8-cortex-dev.iam.gserviceaccount.com` (see `providers.tf`).

## References

- ADR-INFRA-002 — bootstrap via SA impersonation
- ADR-INFRA-003 — VPC topology
- ADR-INFRA-004 — CMEK key hierarchy
- `/docs/runbooks/infrastructure.md` — day-to-day Terraform workflow

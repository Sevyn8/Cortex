# environments/staging

Cortex staging environment root module.

## What lives here

- Module-specific API enablement (adds 10 APIs on top of bootstrap's 6).
- VPC `cortex-vpc` in `sevyn8-cortex-staging`, CIDR plan 10.20.0.0/16.
- `cortex-observer` service account with `roles/viewer`. No Secret Manager access by role design (`roles/viewer` excludes `secretmanager.*`). Drift detection via CI-check planned for P0.5.

## What does NOT live here

- Cloud SQL, Pub/Sub topics, GKE, Cloud Run — per-module prompts (P0.4 onward).
- KMS keyrings and keys — bootstrap-owned.
- Runtime SAs for specific services — per-module prompts.

## Running

```
cd infra/terraform/environments/staging
terraform init
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=cortex-tf-admin@sevyn8-cortex-staging.iam.gserviceaccount.com terraform plan
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=cortex-tf-admin@sevyn8-cortex-staging.iam.gserviceaccount.com terraform apply
```

## Local variables (`local.auto.tfvars`)

Some variables live only in a gitignored `local.auto.tfvars` in this directory — personal identities and credentials never commit. Currently required: `notification_recipients` (list of operator contacts) and `chat_webhook_url` (Google Chat incoming webhook). Without this file, `terraform plan` / `apply` will fail fast with "variable X is required but has no default". Get current values from a shared secure channel (secrets manager, 1Password) or another operator; never paste into chat or commit to the repo.

## Identity

- State: personal ADC via cortex-admins group's `objectAdmin` on the state bucket.
- Resources: provider impersonates `cortex-tf-admin@sevyn8-cortex-staging.iam.gserviceaccount.com`.
- `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` env var is needed for the `google_service_networking_connection` resource — provider impersonation doesn't propagate for that API (see ADR-INFRA-002).

## References

- ADR-INFRA-002 — bootstrap via SA impersonation
- ADR-INFRA-003 — VPC topology
- ADR-INFRA-004 — CMEK key hierarchy
- `/docs/runbooks/infrastructure.md` — day-to-day Terraform workflow

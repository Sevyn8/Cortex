# environments/prod

Cortex production environment root module.

## What lives here

- Module-specific API enablement (adds 10 APIs on top of bootstrap's 6).
- VPC `cortex-vpc` in `sevyn8-cortex-prod`, CIDR plan 10.30.0.0/16.
- `cortex-observer` service account with `roles/viewer`. No Secret Manager access by role design. CI-check drift detection planned for P0.5.

## What does NOT live here

- Cloud SQL, Pub/Sub topics, GKE, Cloud Run — per-module prompts (P0.4 onward).
- KMS keyrings and keys — bootstrap-owned. Phase 1 prod uses SOFTWARE-protection keys; HSM upgrade lands with P11.4 before go-live.
- Runtime SAs for specific services — per-module prompts.

## Running

```
cd infra/terraform/environments/prod
terraform init
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=cortex-tf-admin@sevyn8-cortex-prod.iam.gserviceaccount.com terraform plan
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=cortex-tf-admin@sevyn8-cortex-prod.iam.gserviceaccount.com terraform apply
```

Production applies are gated — the Makefile's `tf-apply-prod` requires `CORTEX_CONFIRM_PROD=yes`.

## Local variables (`local.auto.tfvars`)

Some variables live only in a gitignored `local.auto.tfvars` in this directory — personal identities and credentials never commit. Currently required: `notification_recipients` (list of operator contacts) and `chat_webhook_url` (Google Chat incoming webhook). Without this file, `terraform plan` / `apply` will fail fast with "variable X is required but has no default". Get current values from a shared secure channel (secrets manager, 1Password) or another operator; never paste into chat or commit to the repo.

## Identity

- State: personal ADC via cortex-admins group's `objectAdmin` on the state bucket.
- Resources: provider impersonates `cortex-tf-admin@sevyn8-cortex-prod.iam.gserviceaccount.com`.
- `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` env var needed for `google_service_networking_connection` (see ADR-INFRA-002).

## References

- ADR-INFRA-002 — bootstrap via SA impersonation
- ADR-INFRA-003 — VPC topology
- ADR-INFRA-004 — CMEK key hierarchy (note: prod currently uses SOFTWARE protection; HSM upgrade at P11.4)
- `/docs/runbooks/infrastructure.md` — day-to-day Terraform workflow

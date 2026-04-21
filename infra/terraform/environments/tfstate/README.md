# environments/tfstate

**Stub.** No resources. Reserved for future tfstate-scoped resources that need SA-impersonation lifecycle.

## What bootstrap owns (not here)

- State bucket `cortex-tfstate-5402eb` (CMEK, versioned, 30d soft-delete)
- Keyring `cortex-tfstate-keyring` with key `cortex-tfstate-key`
- SA `cortex-tf-admin@sevyn8-cortex-tfstate`
- IAM on the bucket + SA (cross-project access for other tf-admin SAs, cortex-admins group access)

See `infra/terraform/bootstrap/`.

## Why this stub exists

Bootstrap runs with personal ADC on the operator's machine. If we ever want to change state-bucket or tfstate-KMS lifecycle (e.g., a new bucket lifecycle rule, different rotation cadence, a state-modification alert) _without_ needing a personal-ADC operator run, those resources live here instead — this module runs under SA impersonation like every other env.

The split stays clean: bootstrap for one-shot primitives, this directory for ongoing-change resources.

## Running

```
cd infra/terraform/environments/tfstate
terraform init
terraform plan          # expect: no-resource plan
```

No `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` prefix is needed today (no resources that hit the Service Networking API). If future resources in this module need it, add via the Makefile targets.

## References

- `infra/terraform/bootstrap/` — the primary tfstate-related Terraform
- ADR-INFRA-002 — bootstrap via SA impersonation

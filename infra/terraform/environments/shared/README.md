# environments/shared

Cortex shared plane — hosts Artifact Registry for all environments.

## What lives here

- 3 API enablements: `artifactregistry`, `cloudkms`, `containeranalysis`.
- 3 Docker repositories: `cortex-apps`, `cortex-agents`, `cortex-mcp`. All CMEK-encrypted via the bootstrap-owned `cortex-artifactregistry-key`.
- Cross-project IAM: each env's `cortex-tf-admin` SA is a reader on each repo.

## What does NOT live here

- No networking (no VPC workloads in this project).
- No `cortex-observer` (platform observability is per-env; shared is just the artifact plane).
- No runtime SAs (Cloud Run services in each env get their own reader grants in their respective module prompts).

## Running

```
cd infra/terraform/environments/shared
terraform init
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=cortex-tf-admin@sevyn8-cortex-shared.iam.gserviceaccount.com terraform plan
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=cortex-tf-admin@sevyn8-cortex-shared.iam.gserviceaccount.com terraform apply
```

Or via the Makefile targets (once P0.3's Makefile extensions land): `make tf-plan-shared`, `make tf-apply-shared`.

## Identity

- State: personal ADC via cortex-admins group's `objectAdmin` on the state bucket.
- Resources: provider impersonates `cortex-tf-admin@sevyn8-cortex-shared.iam.gserviceaccount.com`.
- `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` env var workaround only needed if this module later adds resources using the Service Networking API (none currently — shared has no VPC).

## References

- ADR-INFRA-002 — bootstrap via SA impersonation
- ADR-INFRA-004 — CMEK key hierarchy (artifactregistry key is bootstrap-owned in shared's keyring)
- `/docs/runbooks/infrastructure.md` — day-to-day Terraform workflow

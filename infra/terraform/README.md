# Cortex — Terraform

GCP infrastructure as code. Five projects, 168 resources under Terraform management as of P0.3 completion.

## Directory structure

```
infra/terraform/
├── bootstrap/                one-shot, personal ADC, local state
│                             creates: 5 tf-admin SAs, 5 KMS keyrings, 17 keys,
│                             state bucket (cortex-tfstate-5402eb), IAM bindings
│
├── modules/                  reusable building blocks
│   ├── project-baseline/     enable a list of GCP APIs on a project
│   ├── networking/           VPC + 3 subnets + NAT + connector + PSA + 4 firewall rules
│   ├── kms/                  keyring + parametric key list (dormant in P0.3)
│   ├── secret/               CMEK-encrypted Secret Manager helper (dormant in P0.3)
│   └── artifact-registry/    Docker repos with CMEK + cleanup policies + reader IAM
│
└── environments/             per-env root modules, each with its own GCS state prefix
    ├── dev/                  sevyn8-cortex-dev, CIDR 10.10.0.0/16
    ├── staging/              sevyn8-cortex-staging, CIDR 10.20.0.0/16
    ├── prod/                 sevyn8-cortex-prod, CIDR 10.30.0.0/16
    ├── shared/               sevyn8-cortex-shared — Artifact Registry plane, no VPC
    └── tfstate/              sevyn8-cortex-tfstate — stub; state bucket owned by bootstrap
```

## Reading order

New to this directory? Read in this order:

1. **`ADR-INFRA-002`** in `/docs/architecture/decisions/` — why bootstrap exists, why SA impersonation over JSON keys, the 5 provider/GCP quirks you'll hit.
2. **`ADR-INFRA-003`** — VPC topology, CIDR plan, firewall posture.
3. **`ADR-INFRA-004`** — CMEK key hierarchy, 17-key inventory, rotation, P11.4 HSM plan.
4. **`bootstrap/README.md`** — first-time install procedure (one-time per fresh GCP org setup) and bootstrap state loss recovery.
5. **`/docs/runbooks/infrastructure.md`** — day-to-day operations, emergency procedures, adding new environments, cost management.
6. **`/CLAUDE.md`** — Terraform conventions, naming rules, IAM gotchas quick-reference, image tagging.

## Day-to-day entry point

```
make help               # list all tf-* Makefile targets
make tf-plan-all        # drift check across bootstrap + every env
make tf-plan-<env>      # plan a specific environment
make tf-apply-<env>     # apply a specific environment
make CONFIRM=yes tf-apply-prod    # prod applies are gated
```

The Makefile targets automatically set `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` for each env's `cortex-tf-admin` SA — no manual env-var setup.

## Identity model

- **State:** personal ADC (your Sevyn8 Google identity) via `cortex-admins@sevyn8.com` group's `storage.objectAdmin` grant on `cortex-tfstate-5402eb`.
- **Resources:** each env's provider impersonates `cortex-tf-admin@sevyn8-cortex-<env>.iam.gserviceaccount.com` via the group's `tokenCreator` binding.
- **No JSON key files.** Anywhere. Ever.

Humans own state, SAs own resources. See ADR-INFRA-002.

## What is NOT in Terraform

- **GCP projects** (5 projects created out-of-band before bootstrap).
- **Billing account link** (out-of-band).
- **Project-level labels** — see `CLAUDE.md` "Terraform conventions". Manage via `gcloud projects update` if needed.
- **`serviceusage.googleapis.com` enablement on new projects** — required before bootstrap can enable other APIs. One-time `gcloud services enable` per project.

If you find infrastructure that exists in GCP but not in Terraform, that's drift. Either import it (`terraform import` + ADR note) or destroy it (gcloud console or CLI). Console-only resources will eventually bite.

## Version pins

- Terraform: `1.14.8` (repo-root `.terraform-version`); `~> 1.14.0` in every `versions.tf`.
- Providers: `hashicorp/google ~> 6.0`, `hashicorp/google-beta ~> 6.0`, `hashicorp/random ~> 3.6`.

Provider bumps go through an ADR if behavior changes on any of the 5 quirks documented in ADR-INFRA-002.

## References

- `/docs/architecture/decisions/ADR-INFRA-00{2,3,4}.md` — architectural decisions
- `/docs/runbooks/infrastructure.md` — operational procedures
- `/CLAUDE.md` — conventions (SA naming, Secret Manager naming, Terraform conventions, Terraform workflow, IAM gotchas, image tagging)
- `bootstrap/README.md` — first-time install + state recovery
- `modules/*/README.md` — per-module contracts
- `environments/*/README.md` — per-env quick reference

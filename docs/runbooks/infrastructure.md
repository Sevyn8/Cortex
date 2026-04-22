# Cortex Infrastructure Runbook

Operational reference for Terraform-managed GCP infrastructure. Answers "what do I type when X happens?"

Architecture decisions live in `/docs/architecture/decisions/ADR-INFRA-00{2,3,4}`. First-time install lives in `/infra/terraform/bootstrap/README.md`. This doc assumes infrastructure exists and you are operating against it.

---

## Quick reference

| Intent                          | Command                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| Plan every module (drift check) | `make tf-plan-all`                                                 |
| Plan a specific env             | `make tf-plan-dev` (or `-staging`, `-prod`, `-shared`, `-tfstate`) |
| Apply a specific env            | `make tf-apply-dev`                                                |
| Apply prod                      | `make CONFIRM=yes tf-apply-prod`                                   |
| Format all Terraform            | `make tf-fmt`                                                      |
| Inspect state of an env         | `terraform -chdir=infra/terraform/environments/<env> state list`   |
| Show Makefile targets           | `make help`                                                        |

All `tf-plan-*` and `tf-apply-*` targets except bootstrap and tfstate set `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` automatically — no need to export it manually.

---

## Prerequisites

To run anything below you need:

- Terraform 1.14.x installed (`.terraform-version` pins to 1.14.8 at repo root).
- `gcloud` SDK installed with your Sevyn8 identity authenticated:
  ```
  gcloud auth application-default login
  gcloud config set account <you>@sevyn8.com
  ```
- Membership in the `cortex-admins@sevyn8.com` Google Workspace group. Without it, SA impersonation fails with 403.
- `make` available (standard on Linux/macOS; WSL on Windows).

### Before you start

Before operating Cortex infrastructure:

- Confirm gcloud ADC is active as your Sevyn8 identity: `gcloud auth application-default print-access-token` must succeed.
- Confirm you're a member of `cortex-admins@sevyn8.com`. Ask an existing member if unsure.
- **Never edit resources directly in GCP Console** — Terraform tracks state, Console changes cause drift. See ADR-INFRA-002.
- **Prod operations require `CONFIRM=yes`** — this is enforced by the Makefile, not a hint.

---

## Day-to-day operations

### Running a plan

```
make tf-plan-dev
```

Expected output tail: `Plan: X to add, Y to change, Z to destroy.` Review the diff. If it's empty, `No changes. Your infrastructure matches the configuration.`

Plan command is safe to run at any time — it is read-only.

### Running an apply

```
make tf-plan-dev                                                    # plan first
# review diff
terraform -chdir=infra/terraform/environments/dev plan -out=/tmp/dev.tfplan  # save plan file
# ...or apply directly via make if the diff is trivial:
make tf-apply-dev
```

The make target uses interactive `terraform apply` without a saved plan file, which prompts `yes` to proceed. For complex diffs, save a plan file first and apply it with `terraform apply <planfile>` for audit-trail reproducibility.

Prod is gated: `make CONFIRM=yes tf-apply-prod`.

### Drift check across all environments

```
make tf-plan-all
```

Runs plan against bootstrap + all 5 env roots sequentially (dev first, prod last). Output is readable; any env showing non-empty plan is drift.

Typical cadence: weekly, or before starting any multi-env change.

### Inspecting state

```
terraform -chdir=infra/terraform/environments/dev state list
terraform -chdir=infra/terraform/environments/dev state show <resource>
```

State list shows every resource managed in that env. State show inspects a specific resource's attributes. Never `terraform state rm` or `terraform state mv` without an ADR or incident note explaining why.

### Formatting Terraform code

```
make tf-fmt
```

Runs `terraform fmt -recursive` across `infra/terraform/`. Idempotent — safe to run before every commit. CI will eventually enforce this (P0.5).

---

## Emergency procedures

### 1. Apply fails mid-way — recovery

**Symptom:** `terraform apply` exits non-zero partway through; some resources are in state, others are not.

**Recovery:**

1. Inspect what landed: `terraform -chdir=<env> state list | wc -l` — note the count.
2. Re-run the plan: `make tf-plan-<env>` — expect a plan showing only the resources that did _not_ get created.
3. If the plan matches your expectation (remaining work is what's missing), re-apply.
4. If the plan shows unexpected additions or changes, investigate before applying — may indicate GCP-side leftovers from the partial run.

**Do not** run `terraform destroy` to "reset" — it would remove all already-created resources. Partial state + re-apply is the correct path.

### 2. PSA peering first-apply race

**Symptom:** First apply in a fresh env fails with:

```
Error: Error waiting for Create Service Networking Connection:
  Error code 16, message: Request had invalid authentication credentials.
```

This is a known propagation race in newly-API-enabled projects. It is **not** an authentication problem despite the error message.

**Recovery:**

1. Wait 30-60 seconds.
2. Re-run `make tf-apply-<env>`. The second apply creates only the peering resource (plus any other resources that were blocked behind it).

Observed hit rate across P0.3: 2 of 3 environments (dev, staging) hit this; prod did not. Treat retry as "expected-maybe", not "always required". See ADR-INFRA-002 Quirk 2.

### 3. IAM propagation delays

**Symptom:** `permission denied` error on a resource shortly after granting the necessary role.

GCP IAM propagation typically takes 30-90 seconds. New SA token creator bindings, new role grants, and new deny-policy bindings all propagate at this cadence.

**Recovery:**

1. Wait 60-90 seconds.
2. Re-run the failing command.
3. If it still fails after 3 minutes, the grant itself may be wrong — verify with:
   ```
   gcloud projects get-iam-policy <project> --flatten="bindings[].members" \
     --filter="bindings.members:serviceAccount:<sa-email>" \
     --format="value(bindings.role)"
   ```

Not every "permission denied" is propagation — check role coverage against ADR-INFRA-002 Quirks 3 and 4 for the IAM v2 / `roles/iam.denyAdmin` cases.

### 4. Bootstrap state file lost

**Symptom:** The operator's local `infra/terraform/bootstrap/terraform.tfstate` is missing (laptop reformat, accidental delete). GCP resources still exist.

**Recovery:** follow the import procedure documented in `/infra/terraform/bootstrap/README.md#recovery—re-adopting-resources-if-state-is-lost`. It walks through importing the 77 bootstrap resources one by one.

Recovery requires personal ADC from a `cortex-admins` member. Takes 30-60 minutes if no unexpected drift.

**Prevention:** back up `bootstrap/terraform.tfstate` after every bootstrap apply. Gitignored; recommended storage is an encrypted password manager entry or secured personal drive.

### 5. Environment state corruption

**Symptom:** `terraform plan` on an env fails with state-parsing errors, or state diverges from reality unexpectedly.

State is versioned in the GCS bucket (`gs://cortex-tfstate-5402eb/<env>/`). Every apply creates a new state version.

**Recovery:**

1. List versions:
   ```
   gcloud storage ls -a gs://cortex-tfstate-5402eb/<env>/default.tfstate
   ```
2. Identify the last-known-good version (usually the second-most-recent, if the most recent is the corrupt one).
3. Restore:
   ```
   gcloud storage cp gs://cortex-tfstate-5402eb/<env>/default.tfstate#<generation> \
     gs://cortex-tfstate-5402eb/<env>/default.tfstate
   ```
4. Run `terraform -chdir=<env> plan` against restored state — expect a plan reflecting any drift since the restored version.
5. Apply if the plan is correct.

Soft-delete (30-day retention) covers the case where state was fully deleted: restore via `gcloud storage buckets undelete` flow.

### 6. Incident-driven KMS key rotation

**Symptom:** a credential with access to a specific key is suspected compromised (engineer offboarded with exposure, token leaked, etc.).

**Response:**

1. Identify affected key(s) — typically one or two per incident (e.g., `cortex-secrets-key` in dev if a dev DB credential was exposed).
2. Trigger manual rotation:
   ```
   gcloud kms keys versions create --key=<key-name> \
     --keyring=cortex-keyring --location=asia-south1 --project=<env-project> \
     --primary
   ```
3. GCP's automatic rotation continues at 90-day cadence on top of the manual trigger.
4. **Rotation does NOT re-encrypt existing ciphertext.** Older versions remain valid for decryption. If re-encryption is required (compromise severity justifies it), scope a per-resource-class re-encrypt operation — see ADR-INFRA-004 Implementation note 5 for the reference pattern used for HSM migration.
5. Record the rotation in the incident runbook with timestamp, affected keys, and reason.

---

## Adding a new environment

Future pattern — e.g., adding a `sandbox` environment for load testing or a `client-demo` environment for short-lived demos.

### Prerequisites

1. GCP project exists in the sevyn8.com org (created out-of-band).
2. Billing linked.
3. `serviceusage.googleapis.com` enabled in the project.
4. Project number noted (for `data.google_project` lookups).

### Code changes

1. Add the new project to `infra/terraform/bootstrap/variables.tf` `projects` default map, and to the relevant `local.projects` entries in `bootstrap/locals.tf` (keyring name, key list — match dev's 5-key pattern if it's a workload env).
2. Run `make tf-bootstrap-plan` and review — expect new SA, IAM bindings, keyring, 5 keys = ~20 additions per env.
3. Apply bootstrap: `make tf-bootstrap-apply`.
4. Create `infra/terraform/environments/<new-env>/` by copying `dev/` and substituting:
   - `backend.tf` — prefix = `"<new-env>"`
   - `providers.tf` — `impersonate_service_account` → the new tf-admin SA email
   - `terraform.tfvars` — `project_id`, `cidr_octet` (must not collide with 10/20/30; e.g., 40 for sandbox)
   - `main.tf` — `environment = "<new-env>"` in the networking module call, display_name in observer SA
   - `README.md`, `outputs.tf` — substitute env name
5. Add the new env to the Makefile: define `TF_<NEWENV>_DIR`, `SA_<NEWENV>`, and `tf-init-<new-env>` / `tf-plan-<new-env>` / `tf-apply-<new-env>` targets. Add to `.PHONY` and to `tf-plan-all`'s prerequisite list.

### Apply sequence

```
make tf-init-<new-env>
make tf-plan-<new-env>      # review
make tf-apply-<new-env>     # expect PSA peering race — retry once if needed
make tf-plan-<new-env>      # idempotency check
```

### Post-apply verification

Run the verification suite from `/infra/terraform/environments/<new-env>/README.md` (copy from dev's suite and substitute the project name).

---

## Cost management

### Where Phase 1 spend goes

Baseline as of P0.3 completion (no application workloads yet):

| Component                                              |  Monthly cost (₹) |
| ------------------------------------------------------ | ----------------: |
| Bootstrap + state bucket                               |               ~50 |
| 17 KMS keys (all SOFTWARE, ~2 versions each)           |              ~200 |
| Per-env VPC baseline (NAT + VPC Connector + flow logs) | ~900-1100 per env |
| 3 env VPCs total                                       |            ~3,000 |
| Shared (Artifact Registry, zero images stored)         |               ~50 |
| **Total Phase 1 baseline without app workloads**       |        **~3,500** |

Update this table when major new services land:

- P0.4 Cloud SQL adds ~₹8,000/month per env (prod instance + replicas)
- P5.5 Cloud Run is charge-per-request — not baseline, scales with traffic
- P11.4 HSM upgrade for prod adds ~₹2,500/month on top of SOFTWARE baseline
- First tenant data ingestion (Display Data) adds GCS + BigQuery storage costs proportional to data volume

### Budget alert response

Budget alerts (to be configured in P0.6) fire at 50%, 80%, 100% of monthly budget per project.

**On budget alert:**

1. Open the alert — identify which project and which threshold.
2. Check the top-N billable resources: GCP Console → Billing → Reports → group by SKU.
3. Cross-reference against the table above. Unexpected line items = anomaly; investigate.
4. If anomaly, check recent `git log` for infrastructure changes that might explain it.
5. If no explanation, check for a compromised credential (unusual GCE instance spin-up, unexpected BigQuery scans).
6. Capacity-legitimate overruns (e.g., traffic spike) — escalate to Sevyn8 engineering for budget review before throttling.

---

## Cloud SQL operations

Day-to-day database access: running migrations, psql shell, password rotation, proxy
troubleshooting. See ADR-INFRA-005 for instance posture and ADR-DB-001/002/003 for
migration-content conventions.

### Running migrations

1. In a dedicated terminal, start the Cloud SQL Auth Proxy for the target env. Wait for the `Listening on 127.0.0.1:5432 / ready for new connections!` banner.

   ```bash
   make db-proxy-dev        # dev uses public IP per Dev exception; no --private-ip
   make db-proxy-staging    # private-only; Makefile target includes --private-ip
   make db-proxy-prod
   ```

2. In another terminal, run the matching apply target. `PGPASSWORD` is resolved inline from Secret Manager via gcloud. Prod requires `CONFIRM=yes`.

   ```bash
   make db-migrate-dev
   make db-migrate-staging
   make CONFIRM=yes db-migrate-prod
   ```

3. Verify application count after the run:

   ```bash
   PGPASSWORD=$(gcloud secrets versions access latest \
     --secret=cortex-db-postgres-break-glass-<env> \
     --project=sevyn8-cortex-<env>) \
   psql "host=127.0.0.1 port=5432 user=postgres dbname=cortex sslmode=disable" \
     -c "SELECT count(*), max(created_at) FROM __drizzle_migrations;"
   ```

### Psql shell to Cloud SQL

With the proxy running:

```bash
PGPASSWORD=$(gcloud secrets versions access latest \
  --secret=cortex-db-postgres-break-glass-<env> \
  --project=sevyn8-cortex-<env>) \
psql "host=127.0.0.1 port=5432 user=postgres dbname=cortex sslmode=disable"
```

`sslmode=disable` is correct for the proxy hop (TLS terminates at the proxy; the
client-to-proxy leg is localhost). Direct public-IP connections (dev only) must use
`sslmode=require` — Cloud SQL enforces `ENCRYPTED_ONLY` on public IP.

### Proxy troubleshooting

- **`server closed the connection unexpectedly`** at the client → proxy's upstream API call failed. Check the proxy's terminal. Common causes:
  - `oauth2: invalid_grant "invalid_rapt"` → ADC reauth expired. Fix: `gcloud auth application-default login`, then restart proxy.
  - `Config error: instance does not have IP of type "PUBLIC"` → staging/prod instance is private-only and the proxy target is missing `--private-ip`.
- **`Connection refused`** at the client → proxy isn't listening. Verify it's running in the dedicated terminal.
- **Workspace reauth in CI/CD** → not applicable; use Workload Identity Federation (P0.5).

See ADR-INFRA-005 Implementation Notes for the full ADC / `--private-ip` postmortem.

### Password rotation (break-glass)

The `postgres` superuser password is stored in Secret Manager as
`cortex-db-postgres-break-glass-<env>` and applied to the instance via
`gcloud sql users set-password`. Rotation sequence:

1. Generate a new password, store as a new Secret Manager version:

   ```bash
   printf '%s' '<new-password>' | gcloud secrets versions add \
     cortex-db-postgres-break-glass-<env> \
     --project=sevyn8-cortex-<env> --data-file=-
   ```

2. Apply to the Cloud SQL user:

   ```bash
   PASSWORD=$(gcloud secrets versions access latest \
     --secret=cortex-db-postgres-break-glass-<env> \
     --project=sevyn8-cortex-<env>)
   gcloud sql users set-password postgres \
     --instance=cortex-<env>-postgres \
     --project=sevyn8-cortex-<env> \
     --password="$PASSWORD"
   unset PASSWORD
   ```

3. Verify by reconnecting (either via proxy or direct public IP for dev).

Break-glass use only. IAM authentication is the default production path; password
use is operator-triggered for migration runs and incident response.

---

## References

- ADR-INFRA-002 — Terraform bootstrap (SA model + 5 quirks)
- ADR-INFRA-003 — VPC topology (CIDR plan, firewall posture)
- ADR-INFRA-004 — CMEK key hierarchy (17-key inventory, rotation, HSM plan)
- `/infra/terraform/bootstrap/README.md` — first-time install + bootstrap state recovery
- `/infra/terraform/modules/*/README.md` — per-module contracts and inputs/outputs
- `/CLAUDE.md` "IAM gotchas" — quick-reference form of ADR-INFRA-002 Implementation notes

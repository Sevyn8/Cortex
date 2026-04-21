# Cortex Terraform — Bootstrap

**Run ONCE per Cortex installation.** After bootstrap succeeds, all subsequent Terraform work happens in `/infra/terraform/environments/*` with SA impersonation and GCS-backed state. Bootstrap is the root-of-trust that makes that possible.

## What bootstrap creates

- 5 service accounts named `cortex-tf-admin` (one each in `sevyn8-cortex-{dev,staging,prod,tfstate,shared}`)
- `roles/owner` for each SA on its own project
- `roles/iam.serviceAccountTokenCreator` for `cortex-admins@sevyn8.com` on each SA
- 5 KMS keyrings:
  - `cortex-keyring` in dev, staging, prod, shared
  - `cortex-tfstate-keyring` in tfstate
- 17 KMS keys across those keyrings (see `locals.tf` for the full list)
- 1 GCS bucket `cortex-tfstate-<suffix>` in `sevyn8-cortex-tfstate` — CMEK-encrypted, versioning on, 30-day soft-delete, uniform bucket-level access, public-access prevention enforced

Total: roughly 45 Terraform resources.

## Prerequisites

1. All 5 GCP projects must exist and be linked to an active billing account.
2. The Google group `cortex-admins@sevyn8.com` must exist and you must be a member.
3. The `serviceusage.googleapis.com` API must already be enabled in each project (a prerequisite for Terraform enabling any other APIs). Verify:
   ```
   for p in sevyn8-cortex-dev sevyn8-cortex-staging sevyn8-cortex-prod sevyn8-cortex-tfstate sevyn8-cortex-shared; do
     gcloud services list --enabled --project=$p --filter=name:serviceusage --format='value(name)'
   done
   ```
   If any project is missing the enablement, run:
   ```
   gcloud services enable serviceusage.googleapis.com --project=<project-id>
   ```
4. You must have `roles/owner` or an equivalent composite role on each of the 5 projects at the time of bootstrap. After bootstrap completes, you can step this down — ongoing work is done via SA impersonation, not direct ownership.
5. Terraform 1.14.8 and gcloud SDK installed locally.

## Run sequence

```bash
# 1. Authenticate — gives Terraform your Google identity as ADC
gcloud auth application-default login

# 2. Confirm you're in the right context
gcloud auth application-default print-access-token >/dev/null   # must succeed

# 3. Initialize (local backend — no remote state yet)
cd infra/terraform/bootstrap
terraform init

# 4. Plan and review
terraform plan -out=bootstrap.tfplan

# Expected plan summary:
#   Plan: 45 to add, 0 to change, 0 to destroy.
#   Outputs: state_bucket_name, tf_admin_emails, keyring_ids, key_ids

# 5. Apply (only after review)
terraform apply bootstrap.tfplan

# 6. Record the state bucket name — environments/*/backend.tf will use it
terraform output state_bucket_name
```

## After bootstrap

1. Note the value of `state_bucket_name` output. Each environment root module's `backend.tf` hard-codes this value.
2. Back up `terraform.tfstate` (and `terraform.tfstate.backup`) from this directory to secure storage. See "State file warning" below.
3. Proceed to `infra/terraform/environments/dev` for the first environment apply. That module uses SA impersonation and stores state in the bucket you just created.

## State file warning

- The bootstrap state file (`terraform.tfstate`) is gitignored. It never goes into the repo.
- It contains the KMS key resource IDs, SA emails, and bucket name. No private keys, but still sensitive.
- **Back it up.** Recommended: copy to an encrypted password manager entry, or to a secured personal drive, immediately after every successful apply.
- Losing this state file is recoverable (see below) but painful — prefer not to lose it.

## Recovery — re-adopting resources if state is lost

If the bootstrap state file is lost but the GCP resources still exist (which is the most common loss scenario — someone reformatted a laptop), re-adopt the existing resources rather than letting Terraform try to create them again.

```bash
# 0. Start with a fresh bootstrap directory on the new machine
cd infra/terraform/bootstrap
terraform init

# 1. Discover the existing state bucket name (only one matches the prefix)
gcloud storage buckets list --project=sevyn8-cortex-tfstate \
  --filter='name~^cortex-tfstate-' --format='value(name)'
# e.g.: cortex-tfstate-a1b2c3

# 2. Seed the random_id keeper so subsequent plans do not try to regenerate it.
#    Derive the hex suffix from the bucket name:
SUFFIX=a1b2c3   # substitute the actual hex from step 1

terraform import random_id.state_bucket_suffix "project_id:sevyn8-cortex-tfstate,b64_std:$(printf %s "$SUFFIX" | xxd -r -p | base64)"

# 3. Import the state bucket
terraform import google_storage_bucket.tfstate "sevyn8-cortex-tfstate/cortex-tfstate-${SUFFIX}"

# 4. Import each service account (repeat for each project key)
for env in dev staging prod tfstate shared; do
  PROJ="sevyn8-cortex-${env}"
  terraform import "google_service_account.tf_admin[\"${env}\"]" \
    "projects/${PROJ}/serviceAccounts/cortex-tf-admin@${PROJ}.iam.gserviceaccount.com"
done

# 5. Import each project-owner IAM binding
for env in dev staging prod tfstate shared; do
  PROJ="sevyn8-cortex-${env}"
  terraform import "google_project_iam_member.tf_admin_owner[\"${env}\"]" \
    "${PROJ} roles/owner serviceAccount:cortex-tf-admin@${PROJ}.iam.gserviceaccount.com"
done

# 6. Import each token-creator binding
for env in dev staging prod tfstate shared; do
  PROJ="sevyn8-cortex-${env}"
  terraform import "google_service_account_iam_member.tf_admin_impersonation[\"${env}\"]" \
    "projects/${PROJ}/serviceAccounts/cortex-tf-admin@${PROJ}.iam.gserviceaccount.com roles/iam.serviceAccountTokenCreator group:cortex-admins@sevyn8.com"
done

# 7. Import the 5 keyrings
for env in dev staging prod shared; do
  PROJ="sevyn8-cortex-${env}"
  terraform import "google_kms_key_ring.keyring[\"${env}\"]" \
    "projects/${PROJ}/locations/asia-south1/keyRings/cortex-keyring"
done
terraform import 'google_kms_key_ring.keyring["tfstate"]' \
  "projects/sevyn8-cortex-tfstate/locations/asia-south1/keyRings/cortex-tfstate-keyring"

# 8. Import the 17 keys — use `terraform state list` then `terraform plan` to identify any stragglers, then:
terraform import 'google_kms_crypto_key.keys["dev/cortex-cloudsql-key"]' \
  "projects/sevyn8-cortex-dev/locations/asia-south1/keyRings/cortex-keyring/cryptoKeys/cortex-cloudsql-key"
# ... repeat for each of the 17 keys

# 9. Import the Cloud Storage service agent (materialized resource)
terraform import google_project_service_identity.gcs_tfstate \
  "projects/sevyn8-cortex-tfstate/services/storage.googleapis.com"

# 10. Import the CMEK key IAM on the tfstate key
terraform import google_kms_crypto_key_iam_member.gcs_tfstate_key \
  "projects/sevyn8-cortex-tfstate/locations/asia-south1/keyRings/cortex-tfstate-keyring/cryptoKeys/cortex-tfstate-key roles/cloudkms.cryptoKeyEncrypterDecrypter serviceAccount:service-501622945381@gs-project-accounts.iam.gserviceaccount.com"

# 11. Import each project-service enablement — 30 total (5 projects × 6 APIs)
# Generator loop — adjust api list from locals.tf if changed:
for env in dev staging prod tfstate shared; do
  for api in cloudresourcemanager.googleapis.com serviceusage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com cloudkms.googleapis.com storage.googleapis.com; do
    terraform import "google_project_service.bootstrap[\"${env}/${api}\"]" "sevyn8-cortex-${env}/${api}"
  done
done

# 12. Import each bucket-IAM member (5 tf-admin + 1 admin-group)
# Bucket name from step 1
for env in dev staging prod tfstate shared; do
  terraform import "google_storage_bucket_iam_member.tf_admin_state_access[\"${env}\"]" \
    "b/cortex-tfstate-${SUFFIX} roles/storage.objectAdmin serviceAccount:cortex-tf-admin@sevyn8-cortex-${env}.iam.gserviceaccount.com"
done
terraform import google_storage_bucket_iam_member.admin_group_state_access \
  "b/cortex-tfstate-${SUFFIX} roles/storage.objectAdmin group:cortex-admins@sevyn8.com"

# 13. Verify
terraform plan   # must show "No changes. Your infrastructure matches the configuration."
```

If `terraform plan` after import still shows proposed changes, inspect each diff carefully — usually it is a label or metadata drift that is safe to apply; rarely it indicates a misconfigured import and you should `terraform state rm` that resource and re-import.

## Changing bootstrap resources after the fact

Bootstrap resources (the 5 SAs, 5 keyrings, 17 keys, state bucket) should be stable. If you need to change them:

1. Make the change in this module.
2. Reacquire personal-ADC (`gcloud auth application-default login`).
3. `terraform plan` to preview.
4. Get human review of the plan — bootstrap changes blast radius is the whole platform.
5. Apply.
6. Re-back-up the state file.

The `lifecycle { prevent_destroy = true }` on KMS keys and the state bucket prevents accidental destruction via `terraform destroy`. Remove that attribute only with a deliberate PR and an ADR entry explaining why.

## References

- ADR-INFRA-002 — bootstrap via SA impersonation, not JSON keys
- ADR-INFRA-004 — KMS key hierarchy
- `/docs/runbooks/infrastructure.md` — day-to-day Terraform workflow

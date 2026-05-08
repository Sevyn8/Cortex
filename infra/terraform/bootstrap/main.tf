# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap — one-time foundation for the Cortex Terraform control plane.
#
# Creates:
#   - 5 cortex-tf-admin service accounts (one per project)
#   - roles/owner for each SA on its own project
#   - serviceAccountTokenCreator for cortex-admins group on each SA
#   - 5 KMS keyrings (dev, staging, prod, tfstate, shared)
#   - 17 KMS keys across those keyrings
#   - GCS bucket for Terraform state (CMEK, versioned, 30-day soft-delete)
#   - IAM on the state bucket so each tf-admin SA can read/write its own prefix
#
# Subsequent Terraform runs (environments/*) impersonate these SAs and store
# state in this bucket. Bootstrap itself uses local state — see providers.tf.
# ─────────────────────────────────────────────────────────────────────────────

# ─── Enable foundational APIs across all 5 projects ─────────────────────────
resource "google_project_service" "bootstrap" {
  for_each = {
    for pair in setproduct(keys(local.projects), local.bootstrap_apis) :
    "${pair[0]}/${pair[1]}" => {
      project_key = pair[0]
      api         = pair[1]
    }
  }

  project            = local.projects[each.value.project_key].project_id
  service            = each.value.api
  disable_on_destroy = false
}

# ─── Service Accounts: cortex-tf-admin per project ──────────────────────────
resource "google_service_account" "tf_admin" {
  for_each = local.projects

  project      = each.value.project_id
  account_id   = "cortex-tf-admin"
  display_name = "Cortex Terraform Admin (${each.key})"
  description  = "Impersonated by ${var.admin_group} for Terraform apply. Never issue a JSON key for this SA (ADR-INFRA-002)."

  depends_on = [google_project_service.bootstrap]
}

# ─── Grant each tf-admin SA roles/owner on its own project ──────────────────
resource "google_project_iam_member" "tf_admin_owner" {
  for_each = local.projects

  project = each.value.project_id
  role    = "roles/owner"
  member  = "serviceAccount:${google_service_account.tf_admin[each.key].email}"
}

# ─── cortex-admins group gets tokenCreator on each tf-admin SA ──────────────
# This is the single mechanism by which operators gain authority to run
# Terraform in an environment. No one has direct tf-admin credentials.
resource "google_service_account_iam_member" "tf_admin_impersonation" {
  for_each = local.projects

  service_account_id = google_service_account.tf_admin[each.key].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "group:${var.admin_group}"
}

# Deny Admin role intentionally NOT granted here.
# roles/iam.denyAdmin is only grantable at org/folder level, not project level.
# cortex-admins@sevyn8.com does not currently hold org-admin, so env-level deny
# policies are deferred to Phase 2+ when org-admin coordination is done.
# Phase 1 relies on implicit deny: roles/viewer excludes secretmanager.* permissions
# by role design. See ADR-INFRA-002 Implementation notes and P0.5 CI-check task
# for the compensating control.

# ─── KMS Keyrings: one per project ──────────────────────────────────────────
resource "google_kms_key_ring" "keyring" {
  for_each = local.projects

  project  = each.value.project_id
  name     = each.value.keyring_name
  location = var.region

  depends_on = [google_project_service.bootstrap]
}

# ─── KMS Keys: 17 total, defined by locals.all_keys ─────────────────────────
# destroy_scheduled_duration = 30 days per F02 Slice D planning-doc SD6.
# Bumped from the GCP default (24h) so accidental key-version destroys can
# be reverted within a 30-day window — matters for the rotate-with-30-day-
# old-version-cleanup pattern in the lifecycle worker (D.2 + D.4). State
# already carries 30d on existing keys; declaring it explicitly here
# brings source-TF into alignment so the next bootstrap-apply is a no-op.
resource "google_kms_crypto_key" "keys" {
  for_each = local.all_keys

  name                       = each.value.key_name
  key_ring                   = google_kms_key_ring.keyring[each.value.project_key].id
  purpose                    = "ENCRYPT_DECRYPT"
  rotation_period            = local.key_rotation_period
  destroy_scheduled_duration = "2592000s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  labels = local.common_labels

  lifecycle {
    prevent_destroy = true
  }
}

# ─── Cloud Storage service agent for tfstate project ────────────────────────
# Use data source (not google_project_service_identity resource) because
# google-beta's resource returns null .email when the service agent already
# exists in the project (known provider quirk). Data source always returns
# email_address via direct API lookup. See Cortex Git commit history for
# the P0.3 bootstrap incident that drove this change.
data "google_storage_project_service_account" "gcs_tfstate" {
  project = local.projects.tfstate.project_id

  depends_on = [
    google_project_service.bootstrap["tfstate/storage.googleapis.com"],
  ]
}

# ─── Grant the GCS service agent encrypt/decrypt on the tfstate key ─────────
resource "google_kms_crypto_key_iam_member" "gcs_tfstate_key" {
  crypto_key_id = google_kms_crypto_key.keys["tfstate/cortex-tfstate-key"].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs_tfstate.email_address}"
}

# ─── Random suffix for global bucket-name uniqueness ────────────────────────
resource "random_id" "state_bucket_suffix" {
  byte_length = 3

  keepers = {
    # Recompute only if the tfstate project changes — protects against
    # accidental regeneration on unrelated state drift.
    project_id = local.projects.tfstate.project_id
  }
}

# ─── Terraform state bucket (CMEK, versioned, 30-day soft-delete) ───────────
resource "google_storage_bucket" "tfstate" {
  project  = local.projects.tfstate.project_id
  name     = "cortex-tfstate-${random_id.state_bucket_suffix.hex}"
  location = var.region

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 2592000 # 30 days
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.keys["tfstate/cortex-tfstate-key"].id
  }

  labels = merge(local.common_labels, { scope = "tfstate" })

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    google_kms_crypto_key_iam_member.gcs_tfstate_key,
  ]
}

# ─── State bucket IAM ───────────────────────────────────────────────────────
# Each tf-admin SA gets objectAdmin on the bucket. Accepted trade-off: any
# tf-admin can read any env's state. Strict per-prefix isolation via IAM
# Conditions would add complexity without a corresponding threat model win
# for a five-project single-team setup. Revisit if team size or client
# requirements change. — ADR-INFRA-002
resource "google_storage_bucket_iam_member" "tf_admin_state_access" {
  for_each = local.projects

  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.tf_admin[each.key].email}"
}

# Operators (cortex-admins group) also get direct objectAdmin for break-glass
# state inspection and recovery. Without this, a broken SA-impersonation path
# locks everyone out of state.
resource "google_storage_bucket_iam_member" "admin_group_state_access" {
  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectAdmin"
  member = "group:${var.admin_group}"
}

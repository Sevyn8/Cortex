# tenant-data-bucket: per-env GCS bucket for tenant blob storage with
# CMEK encryption, uniform access, public-access prevention, versioning,
# soft-delete, and a runtime service account bound to the bucket.
#
# Slice B substrate per F01 §1.5 — shared bucket with `tenants/{tenantId}/`
# object-key prefix isolation; bucket-per-tenant for ENTERPRISE deferred
# to F02 (see ADR-INFRA-007 + slice-B planning Decision 4).

# ─── GCS service agent (CMEK encrypt/decrypt path) ──────────────────────────
# Bucket-level CMEK is performed by GCS's project service agent
# (service-{project_number}@gs-project-accounts.iam.gserviceaccount.com),
# NOT the runtime SA. Per CLAUDE.md "IAM gotchas" + ADR-INFRA-002 Quirk 1,
# `google_project_service_identity` returns `.email = null` once the
# agent has been materialized; the storage-specific data source resolves
# the existing agent reliably. Mirrors bootstrap/main.tf's tfstate
# bucket pattern.
data "google_storage_project_service_account" "gcs" {
  project = var.project_id
}

resource "google_kms_crypto_key_iam_member" "gcs_agent_cmek" {
  crypto_key_id = var.gcs_kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_service_account" "tenant_data_runtime" {
  project      = var.project_id
  account_id   = "tenant-data-runtime"
  display_name = "Tenant Data Runtime — read/write tenant-prefixed objects"
  description  = "Runtime SA impersonated by services for tenant blob storage I/O. Bound to ${var.environment} CMEK key. Per F01 Slice B / ADR-INFRA-007."
}

resource "google_storage_bucket" "tenant_data" {
  project                     = var.project_id
  name                        = "cortex-${var.environment}-tenant-data"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 2592000 # 30 days, matches tfstate convention
  }

  encryption {
    default_kms_key_name = var.gcs_kms_key_id
  }

  labels = merge(var.common_labels, {
    scope = "tenant-data"
  })

  lifecycle {
    prevent_destroy = true
  }

  # The bucket creation calls KMS encrypt under the GCS service agent's
  # identity to seal the bucket's per-object DEKs; without the agent's
  # CMEK grant in place, GCS returns 403. Both grants must exist before
  # the bucket lands.
  depends_on = [
    google_kms_crypto_key_iam_member.gcs_agent_cmek,
    google_kms_crypto_key_iam_member.gcs_key_runtime,
  ]
}

# Runtime SA gets full object admin on this bucket (read, write, delete,
# list). Tenant-prefix enforcement is application-layer (@cortex/blob-storage
# path validators); SA-level scoping is bucket-wide.
resource "google_storage_bucket_iam_member" "runtime_object_admin" {
  bucket = google_storage_bucket.tenant_data.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.tenant_data_runtime.email}"
}

# Runtime SA can encrypt/decrypt with the GCS CMEK key. Without this,
# bucket reads/writes fail with KMS permission errors at GCS layer.
resource "google_kms_crypto_key_iam_member" "gcs_key_runtime" {
  crypto_key_id = var.gcs_kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.tenant_data_runtime.email}"
}

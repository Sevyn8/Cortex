# ─────────────────────────────────────────────────────────────────────────────
# kms — create a keyring and a list of keys.
#
# Dormant in P0.3: the environment keyrings and their 17 keys are bootstrap-
# owned (see infra/terraform/bootstrap/). This module is the canonical pattern
# for future narrow-scope KMS needs — e.g., a module that wants its own keyring
# disjoint from the shared env keyring.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_kms_key_ring" "this" {
  project  = var.project_id
  name     = var.keyring_name
  location = var.location
}

resource "google_kms_crypto_key" "this" {
  for_each = toset(var.keys)

  name            = each.value
  key_ring        = google_kms_key_ring.this.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.rotation_period

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = var.protection_level
  }

  labels = var.common_labels

  lifecycle {
    prevent_destroy = true
  }
}

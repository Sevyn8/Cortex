# ─────────────────────────────────────────────────────────────────────────────
# secret — create a CMEK-encrypted Secret Manager secret (no version).
#
# Dormant in P0.3: no secrets are created yet. Per-module prompts (P0.7 for
# core helpers, P2.1 for WorkOS, P5.4 for Anthropic, etc.) call this module
# when they need to materialize a secret.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "this" {
  project   = var.project_id
  secret_id = var.secret_id

  replication {
    user_managed {
      dynamic "replicas" {
        for_each = var.replication_locations
        content {
          location = replicas.value
          customer_managed_encryption {
            kms_key_name = var.kms_key_id
          }
        }
      }
    }
  }

  labels = var.common_labels
}

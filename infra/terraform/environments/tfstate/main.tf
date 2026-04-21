# ─────────────────────────────────────────────────────────────────────────────
# environments/tfstate — STUB.
#
# The tfstate project's core resources are owned by the bootstrap module:
#   - State bucket: cortex-tfstate-5402eb (CMEK, versioned, 30d soft-delete)
#   - Keyring: cortex-tfstate-keyring
#   - Key: cortex-tfstate-key
#   - Service account: cortex-tf-admin@sevyn8-cortex-tfstate
#   - IAM bindings on the bucket and SA
#
# This directory is reserved for FUTURE tfstate-scoped resources that need
# Terraform-managed lifecycle and can run under SA impersonation rather than
# personal ADC — e.g., a dedicated key rotation schedule, a bucket lifecycle
# rule that bootstrap doesn't need to own, a monitoring alert on state-bucket
# write activity.
#
# Nothing here today. `terraform plan` reports "No changes" by design.
# ─────────────────────────────────────────────────────────────────────────────

# Kept as a forward-compatibility aid so the module's provider blocks have
# something to reference on first plan without warnings.
data "google_project" "current" {
  project_id = var.project_id
}

# ─────────────────────────────────────────────────────────────────────────────
# project-baseline — activate a list of APIs on a GCP project.
#
# Deliberately does NOT:
#   - Apply project-level labels (see infra/terraform/README.md for why).
#   - Manage the google_project resource itself (projects are created
#     out-of-band, billing is linked out-of-band).
#   - Enable APIs globally; callers curate the list per environment.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_project_service" "activated" {
  for_each = toset(var.activate_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ─── Data Access audit logs for IAM / STS ───────────────────────────────────
# Per ADR-OBS-001: WIF token-exchange failures (sts.googleapis.com
# GenerateAccessToken) are classified as reads, not Admin Activity. They do
# NOT appear in audit logs by default — Data Access logs must be explicitly
# enabled. Without this, the wif_auth_failures log-based metric in the
# monitoring module has nothing to count.
#
# Scope: enable DATA_READ + ADMIN_READ on two services:
#   - iam.googleapis.com: policy reads, role lookups
#   - sts.googleapis.com: token exchanges (the WIF primary signal)
#
# Cost: Data Access logs are charged at standard Cloud Logging rates above
# the 50 GB/month free tier per project. IAM + STS log volume on Cortex's
# current traffic is << 1 GB/month per project. Negligible.
#
# Hardcoded (not a variable): all 4 envs using this module (dev, staging,
# prod, shared) inherit the audit-log config uniformly. Consistent posture;
# shared project sees minimal STS activity but the config is harmless there.
resource "google_project_iam_audit_config" "iam" {
  project = var.project_id
  service = "iam.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "ADMIN_READ"
  }
}

resource "google_project_iam_audit_config" "sts" {
  project = var.project_id
  service = "sts.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "ADMIN_READ"
  }
}

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
# Per ADR-OBS-001: GHA WIF auth failures log to iamcredentials.googleapis.com
# (GenerateAccessToken), NOT sts. The OIDC flow is two-step: STS exchange
# (external OIDC → federated identity) THEN iamcredentials impersonation
# (federated identity → service account, where workflow_ref binding is
# checked — failures land here).
#
# Scope: enable DATA_READ + ADMIN_READ on two services:
#   - iam.googleapis.com: policy reads, role lookups
#   - sts.googleapis.com: external-token exchange (low-signal but kept
#                          for defense-in-depth / future STS-specific filters)
#
# NOT configurable: iamcredentials.googleapis.com does NOT support
# service-level audit config (API returns 400 "does not support service
# level configuration of Google Cloud audit logging"). Its GenerateAccessToken
# failures are logged as Admin Activity by default — the wif_auth_failures
# metric consumes them without any explicit audit_config required.
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

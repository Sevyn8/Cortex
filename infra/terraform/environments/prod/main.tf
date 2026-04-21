# ─────────────────────────────────────────────────────────────────────────────
# environments/prod — Cortex production environment root module.
#
# Mirrors environments/dev and environments/staging with three differences:
#   - project_id: sevyn8-cortex-prod
#   - cidr_octet: 30 (subnets derive to 10.30.x.x)
#   - provider impersonation: cortex-tf-admin@sevyn8-cortex-prod
#
# Phase 1 uses SOFTWARE-protection KMS keys for prod (per ADR-INFRA-004).
# HSM upgrade is scheduled for P11.4 before Display Data go-live.
# ─────────────────────────────────────────────────────────────────────────────

data "google_project" "current" {
  project_id = var.project_id
}

# ─── Project-baseline APIs ──────────────────────────────────────────────────
module "project_baseline" {
  source     = "../../modules/project-baseline"
  project_id = var.project_id

  activate_apis = [
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "vpcaccess.googleapis.com",
    "secretmanager.googleapis.com",
    "pubsub.googleapis.com",
    "sqladmin.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

# ─── Networking — VPC, subnets, NAT, connector, PSA, firewall ──────────────
module "networking" {
  source = "../../modules/networking"

  project_id  = var.project_id
  environment = "prod"
  region      = var.region
  cidr_octet  = var.cidr_octet

  depends_on = [module.project_baseline]
}

# ─── cortex-observer SA ─────────────────────────────────────────────────────
resource "google_service_account" "observer" {
  project      = var.project_id
  account_id   = "cortex-observer"
  display_name = "Cortex Observer (prod) — read-only, no Secret Manager access"
  description  = "Platform observer identity. roles/viewer on the project. No Secret Manager access by role design (roles/viewer excludes secretmanager.*). P0.5 adds CI-check for drift detection. See ADR-INFRA-002."

  depends_on = [module.project_baseline]
}

resource "google_project_iam_member" "observer_viewer" {
  project = var.project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.observer.email}"
}

# IAM Deny Policy intentionally NOT created here.
# See bootstrap/main.tf and environments/dev/main.tf for the full explanation.
# Phase 1 relies on implicit deny via role design; P0.5 adds a CI-check.

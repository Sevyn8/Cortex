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
    "cloudbuild.googleapis.com",
    "cloudtasks.googleapis.com",
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

# ─── Cloud SQL — Postgres 17 Enterprise, private IP, CMEK ──────────────────
# Phase A of P0.4. Posture decisions locked in ADR-INFRA-005. Phase B
# (migrations, bi-temporal helpers, RLS, audit) runs against this instance
# but lives in /services/foundation/migrations/, not Terraform.

# Look up the CMEK key provisioned in bootstrap — cortex-cloudsql-key in the prod env's cortex-keyring (asia-south1).
data "google_kms_key_ring" "cortex" {
  project  = var.project_id
  name     = "cortex-keyring"
  location = var.region
}

data "google_kms_crypto_key" "cloudsql" {
  name     = "cortex-cloudsql-key"
  key_ring = data.google_kms_key_ring.cortex.id
}

data "google_kms_crypto_key" "gcs" {
  name     = "cortex-gcs-key"
  key_ring = data.google_kms_key_ring.cortex.id
}

module "cloud_sql" {
  source = "../../modules/cloud-sql"

  project_id         = var.project_id
  project_number     = data.google_project.current.number
  environment        = "prod"
  region             = var.region
  private_network_id = module.networking.vpc_self_link
  kms_key_id         = data.google_kms_crypto_key.cloudsql.id

  # Per-env values locked in ADR-INFRA-005 Decisions 3, 4, 5, 11.
  # Prod is the only env with REGIONAL HA, 4 vCPU / 16 GB, and 14-day backups.
  tier                  = "db-custom-4-16384"
  availability_type     = "REGIONAL"
  backup_retained_count = 14
  pitr_retention_days   = 7
  max_connections       = 200

  # P0.4-phase label override. Preserves prompt="p0-3" on P0.3 resources.
  common_labels = merge(var.common_labels, { prompt = "p0-4" })

  # Networking (PSA peering) and sqladmin API must be in place before
  # instance creation. project_baseline carries the API; networking carries
  # the service-networking connection.
  depends_on = [module.project_baseline, module.networking]
}

# ─── CI migration runner — per-env submit/worker SAs + Cloud Build private pool ──
# Per ADR-CI-001: Cloud Build runs inside VPC with --private-ip, authenticated
# via WIF. Worker SA (cortex-ci-migration-prod) holds Cloud SQL + Secret
# Manager roles; submit SA (cortex-ci-submit-prod) is the WIF-facing
# identity. See ADR-INFRA-006 for the submit/worker split rationale.
module "ci_runner" {
  source = "../../modules/ci-runner"

  project_id                = var.project_id
  project_number            = data.google_project.current.number
  environment               = "prod"
  region                    = var.region
  vpc_id                    = module.networking.vpc_id
  cloudbuild_psa_range_cidr = module.networking.cloudbuild_psa_range_cidr
  break_glass_secret_id     = "cortex-db-postgres-break-glass-prod"

  depends_on = [module.project_baseline, module.networking]
}

# ─── WIF binding — submit SA impersonation scoped to migrate-prod.yaml@main ──
# Per ADR-INFRA-006 Decision 5: only the exact workflow file at the exact ref
# can federate into this SA.
resource "google_service_account_iam_member" "wif_submit_prod" {
  service_account_id = module.ci_runner.submit_sa_resource_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${var.wif_pool_principal_set_base}/attribute.workflow_ref/Sevyn8/Cortex/.github/workflows/migrate-prod.yaml@refs/heads/main"
}

# ─── Monitoring — alert policies + notification channels ────────────────────
# Per ADR-OBS-001: operator-facing observability substrate. CRITICAL alerts
# route to email + Google Chat; WARNING alerts route to email only.
# depends_on ensures project-baseline's audit-log config (iam + sts) lands
# before monitoring's log-based metrics reference STS token-exchange events.
module "monitoring" {
  source = "../../modules/monitoring"

  project_id                = var.project_id
  environment               = "prod"
  cloud_sql_instance_name   = "cortex-prod-postgres"
  cloud_sql_max_connections = 200
  notification_recipients   = var.notification_recipients
  chat_webhook_url          = var.chat_webhook_url

  depends_on = [module.project_baseline]
}

# ─── Tenant-data bucket (F01 Slice B) ───────────────────────────────────────
# Per F01 §1.5 + slice-B planning Decision 4: shared bucket per env,
# tenant prefix isolation enforced application-side via @cortex/blob-storage.
# Bucket-per-tenant for ENTERPRISE deferred to F02 (ADR-INFRA-007).
module "tenant_data_bucket" {
  source = "../../modules/tenant-data-bucket"

  project_id     = var.project_id
  environment    = "prod"
  region         = var.region
  gcs_kms_key_id = data.google_kms_crypto_key.gcs.id

  common_labels = merge(var.common_labels, { prompt = "p1-1-slice-b" })

  depends_on = [module.project_baseline]
}

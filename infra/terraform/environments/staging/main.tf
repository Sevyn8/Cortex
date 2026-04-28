# ─────────────────────────────────────────────────────────────────────────────
# environments/staging — Cortex staging environment root module.
#
# Mirrors environments/dev with three differences:
#   - project_id: sevyn8-cortex-staging
#   - cidr_octet: 20 (subnets derive to 10.20.x.x)
#   - provider impersonation: cortex-tf-admin@sevyn8-cortex-staging
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
  environment = "staging"
  region      = var.region
  cidr_octet  = var.cidr_octet

  depends_on = [module.project_baseline]
}

# ─── cortex-observer SA ─────────────────────────────────────────────────────
resource "google_service_account" "observer" {
  project      = var.project_id
  account_id   = "cortex-observer"
  display_name = "Cortex Observer (staging) — read-only, no Secret Manager access"
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

# Look up the CMEK key provisioned in bootstrap — cortex-cloudsql-key in the staging env's cortex-keyring (asia-south1).
data "google_kms_key_ring" "cortex" {
  project  = var.project_id
  name     = "cortex-keyring"
  location = var.region
}

data "google_kms_crypto_key" "cloudsql" {
  name     = "cortex-cloudsql-key"
  key_ring = data.google_kms_key_ring.cortex.id
}

data "google_kms_crypto_key" "secrets" {
  name     = "cortex-secrets-key"
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
  environment        = "staging"
  region             = var.region
  private_network_id = module.networking.vpc_self_link
  kms_key_id         = data.google_kms_crypto_key.cloudsql.id

  # Per-env values locked in ADR-INFRA-005 Decisions 3, 4, 5, 11.
  tier                  = "db-custom-2-8192"
  availability_type     = "ZONAL"
  backup_retained_count = 7
  pitr_retention_days   = 3
  max_connections       = 100

  # P0.4-phase label override. Preserves prompt="p0-3" on P0.3 resources.
  common_labels = merge(var.common_labels, { prompt = "p0-4" })

  # Networking (PSA peering) and sqladmin API must be in place before
  # instance creation. project_baseline carries the API; networking carries
  # the service-networking connection.
  depends_on = [module.project_baseline, module.networking]
}

# ─── CI migration runner — per-env submit/worker SAs + Cloud Build private pool ──
# Per ADR-CI-001: Cloud Build runs inside VPC with --private-ip, authenticated
# via WIF. Worker SA (cortex-ci-migration-staging) holds Cloud SQL + Secret
# Manager roles; submit SA (cortex-ci-submit-staging) is the WIF-facing
# identity. See ADR-INFRA-006 for the submit/worker split rationale.
module "ci_runner" {
  source = "../../modules/ci-runner"

  project_id                = var.project_id
  project_number            = data.google_project.current.number
  environment               = "staging"
  region                    = var.region
  vpc_id                    = module.networking.vpc_id
  cloudbuild_psa_range_cidr = module.networking.cloudbuild_psa_range_cidr
  break_glass_secret_id     = "cortex-db-postgres-break-glass-staging"

  depends_on = [module.project_baseline, module.networking]
}

# ─── WIF binding — submit SA impersonation scoped to migrate-staging.yaml@main ──
# Per ADR-INFRA-006 Decision 5: only the exact workflow file at the exact ref
# can federate into this SA.
resource "google_service_account_iam_member" "wif_submit_staging" {
  service_account_id = module.ci_runner.submit_sa_resource_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${var.wif_pool_principal_set_base}/attribute.workflow_ref/Sevyn8/Cortex/.github/workflows/migrate-staging.yaml@refs/heads/main"
}

# ─── Monitoring — alert policies + notification channels ────────────────────
# Per ADR-OBS-001: operator-facing observability substrate. CRITICAL alerts
# route to email + Google Chat; WARNING alerts route to email only.
# depends_on ensures project-baseline's audit-log config (iam + sts) lands
# before monitoring's log-based metrics reference STS token-exchange events.
module "monitoring" {
  source = "../../modules/monitoring"

  project_id                = var.project_id
  environment               = "staging"
  cloud_sql_instance_name   = "cortex-staging-postgres"
  cloud_sql_max_connections = 100
  notification_recipients   = var.notification_recipients
  chat_webhook_url          = var.chat_webhook_url

  depends_on = [module.project_baseline]
}

# ─── Super Admin initial password secret (P0.9) ────────────────────────────
# Per ADR-SEQ-001 amendment: the P0.9 bootstrap script (scripts/bootstrap/
# create-super-admin.ts) writes the initial super admin password into this
# secret's latest version. AC01 (P2.1) reads it at promotion time to seed
# the users + user_role_assignment tables.
#
# Metadata lives in Terraform; version populated by the bootstrap script
# via @cortex/secrets secrets.put. Prod has NO equivalent — production uses
# WorkOS SSO with an env-var-specified initial user validated on AC01 first
# run. See /docs/runbooks/super-admin-bootstrap.md.
module "secret_super_admin_initial" {
  source = "../../modules/secret"

  project_id = var.project_id
  secret_id  = "cortex-auth-super-admin-initial-staging"
  kms_key_id = data.google_kms_crypto_key.secrets.id

  common_labels = {
    managed_by  = "terraform"
    project     = "cortex"
    environment = "staging"
    prompt      = "p0-9"
  }

  depends_on = [module.project_baseline]
}

# ─── Tenant-data bucket (F01 Slice B) ───────────────────────────────────────
# Per F01 §1.5 + slice-B planning Decision 4: shared bucket per env,
# tenant prefix isolation enforced application-side via @cortex/blob-storage.
# Bucket-per-tenant for ENTERPRISE deferred to F02 (ADR-INFRA-007).
module "tenant_data_bucket" {
  source = "../../modules/tenant-data-bucket"

  project_id     = var.project_id
  environment    = "staging"
  region         = var.region
  gcs_kms_key_id = data.google_kms_crypto_key.gcs.id

  common_labels = merge(var.common_labels, { prompt = "p1-1-slice-b" })

  depends_on = [module.project_baseline]
}

# ─── Tenant lifecycle runtime SA (F02 Slice C sub-phase 7.6) ───────────────
# Per Q-NEW-C19 + Q-NEW-C20 locks: workload-scoped runtime identity for the
# F02 lifecycle workflows (tenants.provision / suspend / resume / offboard /
# terminate / forceTerminate). Slice D's per-tenant Cloud Run service module
# attaches this SA as serviceAccountEmail. The cloud-tasks-queue module
# instantiations below grant cloudtasks.enqueuer to it; storage.objectAdmin
# grant below covers offboard's archive upload + terminate's prefix delete.
resource "google_service_account" "tenant_lifecycle_runtime" {
  project      = var.project_id
  account_id   = "tenant-lifecycle-runtime"
  display_name = "Tenant lifecycle runtime (staging)"
  description  = "Runtime identity for F02 lifecycle workflows. Dispatches Cloud Tasks to lifecycle-queue + provisioning-queue; reads/writes the tenant-data bucket. Slice C sub-phase 7.6."

  depends_on = [module.project_baseline]
}

resource "google_storage_bucket_iam_member" "lifecycle_runtime_object_admin" {
  bucket = module.tenant_data_bucket.bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.tenant_lifecycle_runtime.email}"
}

# ─── Cloud Tasks queues (F02 Slice C sub-phase 7.6) ─────────────────────────
# Per Q-NEW-C18 lock: both queues wired in this sub-phase.

module "cloud_tasks_provisioning_queue" {
  source = "../../modules/cloud-tasks-queue"

  project_id                 = var.project_id
  location                   = var.region
  queue_name                 = "provisioning-queue"
  dispatcher_service_account = google_service_account.tenant_lifecycle_runtime.email

  depends_on = [module.project_baseline]
}

module "cloud_tasks_lifecycle_queue" {
  source = "../../modules/cloud-tasks-queue"

  project_id                 = var.project_id
  location                   = var.region
  queue_name                 = "lifecycle-queue"
  dispatcher_service_account = google_service_account.tenant_lifecycle_runtime.email

  depends_on = [module.project_baseline]
}

# ─── Export-signer SA (F02 Slice C sub-phase 7.6) ───────────────────────────
# Per convention §10.8 + Q-NEW-C21/C22/C23 locks. App-side impersonation
# deferred; runtime SA currently signs as itself. See convention §6.1.
module "cortex_signer_sa" {
  source = "../../modules/cortex-signer-sa"

  project_id              = var.project_id
  environment             = "staging"
  runtime_sa_email        = google_service_account.tenant_lifecycle_runtime.email
  tenant_data_bucket_name = module.tenant_data_bucket.bucket_name
}

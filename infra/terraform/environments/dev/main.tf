# ─────────────────────────────────────────────────────────────────────────────
# environments/dev — Cortex dev environment root module.
#
# Calls the shared modules to provision:
#   - Module-specific APIs on sevyn8-cortex-dev (beyond the 6 bootstrap APIs)
#   - VPC + subnets + NAT + connector + PSA + firewall (10.10.x.x CIDR plan)
#
# Plus inline:
#   - cortex-observer service account (read-only, no secret access)
#   - IAM deny policy enforcing the "no secret access" constraint in code
# ─────────────────────────────────────────────────────────────────────────────

# ─── Project lookup — needed for project_number in deny-policy principals ───
data "google_project" "current" {
  project_id = var.project_id
}

# ─── Project-baseline APIs ──────────────────────────────────────────────────
# Bootstrap already enables: cloudresourcemanager, serviceusage, iam,
# iamcredentials, cloudkms, storage. This module adds the rest needed for
# Phase 1 env workloads.
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
  environment = "dev"
  region      = var.region
  cidr_octet  = var.cidr_octet

  depends_on = [module.project_baseline]
}

# ─── cortex-observer SA — read-only platform role, no secret access ────────
# The SA name is deliberately not suffixed with "-dev". Each env project
# has exactly one cortex-observer; the project qualifier is in the email.
resource "google_service_account" "observer" {
  project      = var.project_id
  account_id   = "cortex-observer"
  display_name = "Cortex Observer (dev) — read-only, no Secret Manager access"
  description  = "Platform observer identity. roles/viewer on the project. No Secret Manager access by role design (roles/viewer excludes secretmanager.*). P0.5 adds CI-check for drift detection. See ADR-INFRA-002."

  depends_on = [module.project_baseline]
}

# Base read permission. roles/viewer does NOT grant secretmanager.* access
# by default (Secret Manager uses its own role family), so this alone would
# not leak secret values. The deny policy below codifies that intent.
resource "google_project_iam_member" "observer_viewer" {
  project = var.project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.observer.email}"
}

# IAM Deny Policy intentionally NOT created here.
# See bootstrap/main.tf for the full explanation. Phase 1 relies on implicit deny
# via role design. P0.5 will add a CI-check validation that cortex-observer's
# effective permissions include zero secretmanager.* verbs, providing equivalent
# drift detection without requiring org-level roles/iam.denyAdmin.

# ─── Cloud SQL — Postgres 17 Enterprise, private IP, CMEK ──────────────────
# Phase A of P0.4. Posture decisions locked in ADR-INFRA-005. Phase B
# (migrations, bi-temporal helpers, RLS, audit) runs against this instance
# but lives in /services/foundation/migrations/, not Terraform.

# Look up the CMEK key provisioned in bootstrap — cortex-cloudsql-key
# in the dev env's cortex-keyring (asia-south1).
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
  environment        = "dev"
  region             = var.region
  private_network_id = module.networking.vpc_self_link
  kms_key_id         = data.google_kms_crypto_key.cloudsql.id

  # Per-env values locked in ADR-INFRA-005 Decisions 3, 4, 5, 11.
  tier                  = "db-custom-2-8192"
  availability_type     = "ZONAL"
  backup_retained_count = 7
  pitr_retention_days   = 1
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
# via WIF. Worker SA (cortex-ci-migration-dev) holds Cloud SQL + Secret Manager
# roles; submit SA (cortex-ci-submit-dev) is the WIF-facing identity.
# See ADR-INFRA-006 for the submit/worker split rationale.
module "ci_runner" {
  source = "../../modules/ci-runner"

  project_id                = var.project_id
  project_number            = data.google_project.current.number
  environment               = "dev"
  region                    = var.region
  vpc_id                    = module.networking.vpc_id
  cloudbuild_psa_range_cidr = module.networking.cloudbuild_psa_range_cidr
  break_glass_secret_id     = "cortex-db-postgres-break-glass-dev"

  depends_on = [module.project_baseline, module.networking]
}

# ─── WIF binding — submit SA impersonation scoped to migrate-dev.yaml@main ──
# Per ADR-INFRA-006 Decision 5: only the exact workflow file at the exact ref
# can federate into this SA. Feature branches and PR-added workflows cannot
# impersonate the submit SA.
resource "google_service_account_iam_member" "wif_submit_dev" {
  service_account_id = module.ci_runner.submit_sa_resource_name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${var.wif_pool_principal_set_base}/attribute.workflow_ref/Sevyn8/Cortex/.github/workflows/migrate-dev.yaml@refs/heads/main"
}

# ─── Monitoring — alert policies + notification channels ────────────────────
# Per ADR-OBS-001: operator-facing observability substrate. CRITICAL alerts
# route to email + Google Chat; WARNING alerts route to email only.
# depends_on ensures project-baseline's audit-log config (iam + sts) lands
# before monitoring's log-based metrics reference STS token-exchange events.
module "monitoring" {
  source = "../../modules/monitoring"

  project_id                = var.project_id
  environment               = "dev"
  cloud_sql_instance_name   = "cortex-dev-postgres"
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
  secret_id  = "cortex-auth-super-admin-initial-dev"
  kms_key_id = data.google_kms_crypto_key.secrets.id

  common_labels = {
    managed_by  = "terraform"
    project     = "cortex"
    environment = "dev"
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
  environment    = "dev"
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
# Project-scoped name (no -dev suffix) per workspace SA-naming convention —
# the project_id qualifier in the email already encodes the env.
resource "google_service_account" "tenant_lifecycle_runtime" {
  project      = var.project_id
  account_id   = "tenant-lifecycle-runtime"
  display_name = "Tenant lifecycle runtime (dev)"
  description  = "Runtime identity for F02 lifecycle workflows. Dispatches Cloud Tasks to lifecycle-queue + provisioning-queue; reads/writes the tenant-data bucket. Slice C sub-phase 7.6."

  depends_on = [module.project_baseline]
}

# Storage objectAdmin on tenant-data: needed for offboard's archive upload
# + terminate's recursive prefix delete. Tenant-prefix enforcement is
# application-layer (@cortex/blob-storage path validators).
resource "google_storage_bucket_iam_member" "lifecycle_runtime_object_admin" {
  bucket = module.tenant_data_bucket.bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.tenant_lifecycle_runtime.email}"
}

# ─── Cloud Tasks queues (F02 Slice C sub-phase 7.6) ─────────────────────────
# Per Q-NEW-C18 lock: both queues wired in this sub-phase. Slice A authored
# the cloud-tasks-queue module but deferred per-env instantiation pending the
# runtime SA (now provisioned above). The dispatcher_service_account flows
# from tenant_lifecycle_runtime; the module grants cloudtasks.enqueuer.

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
# Per convention §10.8 + Q-NEW-C21/C22/C23 locks: workload-scoped signing
# identity for tenant export pre-signed URLs. Module creates the SA, grants
# tenant_lifecycle_runtime roles/iam.serviceAccountTokenCreator on it (so
# the runtime can call IAM SignBlob), and grants the signer SA
# storage.objectViewer on the tenant-data bucket (so signed URLs grant valid
# access). Application-side impersonation code change is deferred — runtime
# SA currently signs as itself via default ADC. See convention §6.1 for the
# staged-rollout note.
module "cortex_signer_sa" {
  source = "../../modules/cortex-signer-sa"

  project_id              = var.project_id
  environment             = "dev"
  runtime_sa_email        = google_service_account.tenant_lifecycle_runtime.email
  tenant_data_bucket_name = module.tenant_data_bucket.bucket_name
}

# ─── F02 Slice D D.4 — tenant-lifecycle-shared deployment ───────────────────
# Adds the cross-cutting bindings needed to deploy tenant-lifecycle-api as a
# Cloud Run service running as tenant_lifecycle_runtime:
#   1. Operator break-glass impersonation (roles/iam.serviceAccountUser)
#   2. Cloud SQL IAM auth path (cloudsql.client + instanceUser + sql_user)
#   3. Cross-project Artifact Registry pull (cortex-apps in shared)
#   4. Key-rotation-queue (Cloud Tasks dispatch)
#   5. tenant-lifecycle-shared Cloud Run service via tenant-cloud-run-service
#
# Companion migration 0012_tenant_lifecycle_runtime_grants.sql provisions the
# SQL-level GRANTs for the role created by google_sql_user below.

# 1. Operator-email → roles/iam.serviceAccountUser on the runtime SA. Lets
#    listed operators run break-glass `gcloud run deploy --service-account=
#    tenant-lifecycle-runtime@<project>.iam.gserviceaccount.com` without
#    standing access to the SA's key material. List lives in local.auto.tfvars.
resource "google_service_account_iam_member" "lifecycle_runtime_operator_user" {
  for_each = toset(var.operator_emails)

  service_account_id = google_service_account.tenant_lifecycle_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "user:${each.value}"
}

# 2. Cloud SQL IAM auth — three pieces. roles/cloudsql.client lets the SA
#    reach the instance over private IP; roles/cloudsql.instanceUser lets the
#    SA login via IAM (not password); google_sql_user of type
#    CLOUD_IAM_SERVICE_ACCOUNT registers the SA as a Cloud SQL DB role
#    (visible in pg_roles after first connect). Migration 0012 grants the
#    SQL-level permissions the role then needs.
resource "google_project_iam_member" "lifecycle_runtime_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.tenant_lifecycle_runtime.email}"
}

resource "google_project_iam_member" "lifecycle_runtime_cloudsql_instance_user" {
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.tenant_lifecycle_runtime.email}"
}

resource "google_sql_user" "lifecycle_runtime" {
  project  = var.project_id
  instance = module.cloud_sql.instance_name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
  # Cloud SQL IAM-auth username convention: SA email minus the
  # ".gserviceaccount.com" suffix.
  name = replace(google_service_account.tenant_lifecycle_runtime.email, ".gserviceaccount.com", "")
}

# 3. Cross-project Artifact Registry pull. The cortex-apps repo lives in
#    sevyn8-cortex-shared (per shared/main.tf). Each env's runtime SA gets
#    artifactregistry.reader on that repo so Cloud Run can pull images.
#    Repo-level (not project-level) grant — narrowest viable scope.
resource "google_artifact_registry_repository_iam_member" "lifecycle_runtime_apps_reader" {
  project    = var.shared_project_id
  location   = var.region
  repository = "cortex-apps"
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.tenant_lifecycle_runtime.email}"
}

# Cloud Run *deployment* uses a separate identity from the runtime SA: the
# per-project Cloud Run Service Agent (`service-{project_number}@
# serverless-robot-prod.iam.gserviceaccount.com`). When pulling images
# cross-project, this Service Agent ALSO needs
# `roles/artifactregistry.reader` on cortex-apps — the runtime SA's grant
# above only covers runtime image pulls. Without this binding,
# `gcloud run services update --image=<cross-project>` fails with
# "Cloud Run Service Agent must have permission to read the image".
# Email is project-number-derived and Google-managed; one per env.
resource "google_artifact_registry_repository_iam_member" "cloud_run_service_agent_apps_reader" {
  project    = var.shared_project_id
  location   = var.region
  repository = "cortex-apps"
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${data.google_project.current.number}@serverless-robot-prod.iam.gserviceaccount.com"
}

# 4. Cloud Tasks queue for KMS key-rotation worker dispatches. Pattern matches
#    provisioning-queue + lifecycle-queue above (Slice C); same dispatcher SA.
#    Halved dispatch rate vs. the others — KMS rotation is slow async work
#    (CreateCryptoKeyVersion + UpdateCryptoKeyPrimaryVersion + 30-day destroy
#    schedule); 5/s is generous. max_concurrent_dispatches stays at module
#    default (10) — tasks block on KMS API, not DB connections.
module "cloud_tasks_key_rotation_queue" {
  source = "../../modules/cloud-tasks-queue"

  project_id                 = var.project_id
  location                   = var.region
  queue_name                 = "key-rotation-queue"
  dispatcher_service_account = google_service_account.tenant_lifecycle_runtime.email
  max_dispatches_per_second  = 5

  depends_on = [module.project_baseline]
}

# 5. tenant-lifecycle-shared Cloud Run service. Mode=shared per Q-NEW-D-10
#    (STANDARD-tier tenants share; ENTERPRISE per-tenant deploys land
#    post-ADR-INFRA-005 swap). Image URI defaults empty + lifecycle.
#    ignore_changes preserves out-of-band gcloud-run-deploy SHAs.
#
#    min_instances = 0 in dev: cold-start is observable (intentional —
#    cold-start measurements feed §6 budget validation). Staging and prod
#    set 1 to eliminate platform-cold-start from operator hot path.
#
#    Worker URLs (LIFECYCLE_WORKER_URL, PROVISIONING_WORKER_URL) are
#    declared below as self-references — the dispatcher + worker are the
#    same Cloud Run service. The URL `tenant_lifecycle_image_uri` is
#    deterministic per project + service (Cloud Run v2 hash format) so
#    can be hardcoded in `local.auto.tfvars` once the first revision
#    lands. KEY_ROTATION_WORKER_URL is not consumed by Phase-1 code (the
#    `/v1/_workers/key-rotation` route is pull-only); add when the
#    enqueue path goes live. Original D.4 design said "out-of-band" but
#    that was never wired in deploy-dev.sh — surfaced + corrected in D.4
#    close-out.
module "tenant_lifecycle_shared" {
  source = "../../modules/tenant-cloud-run-service"

  project_id                        = var.project_id
  location                          = var.region
  environment                       = "dev"
  mode                              = "shared"
  workload                          = "tenant-lifecycle"
  runtime_sa_email                  = google_service_account.tenant_lifecycle_runtime.email
  cloudsql_instance_connection_name = module.cloud_sql.connection_name
  vpc_connector_id                  = module.networking.vpc_connector_id
  image_uri                         = var.tenant_lifecycle_image_uri
  min_instances                     = 0

  # Dev-only env knobs. NODE_ENV=development unlocks /v1/test/slow-5s;
  # ENABLE_TEST_ROUTES=true unlocks the test-routes mounted under
  # /v1/test/*. Staging + prod do NOT carry these (production posture
  # per convention §7.1). COMMIT_SHA is image-baked at build time via
  # the Dockerfile ARG (set by `make image-bootstrap`), so it doesn't
  # need to be a Cloud Run env var here. Closes the deploy-vs-TF
  # env-var drift seam discovered during D.4 finalization.
  #
  # Worker URLs are self-references: tenant-lifecycle-shared dispatches
  # to itself via Cloud Tasks. Cloud Run v2 service URLs are stable per
  # `(project, region, service-name)` — sourced from
  # `var.tenant_lifecycle_service_url` (set via local.auto.tfvars after
  # first revision lands). Empty default → omit the env var (the create
  # path will 500 with a clear error message). See convention §7.4.
  extra_env_vars = merge(
    {
      NODE_ENV           = "development"
      ENABLE_TEST_ROUTES = "true"
    },
    var.tenant_lifecycle_service_url != "" ? {
      PROVISIONING_WORKER_URL = "${var.tenant_lifecycle_service_url}/v1/_workers/provision"
      LIFECYCLE_WORKER_URL    = "${var.tenant_lifecycle_service_url}/v1/_workers/lifecycle"
    } : {},
  )

  common_labels = merge(var.common_labels, { prompt = "p1-2-slice-d-d4" })

  depends_on = [
    module.cloud_sql,
    google_sql_user.lifecycle_runtime,
    google_project_iam_member.lifecycle_runtime_cloudsql_client,
    google_project_iam_member.lifecycle_runtime_cloudsql_instance_user,
    google_artifact_registry_repository_iam_member.lifecycle_runtime_apps_reader,
    module.cloud_tasks_key_rotation_queue,
  ]
}

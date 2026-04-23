# ─────────────────────────────────────────────────────────────────────────────
# ci-runner — Per-env Cloud Build migration runner: SA pair + private pool.
#
# Per ADR-CI-001 + ADR-INFRA-006 Decisions 4-5:
#   - cortex-ci-submit-{env}: receives WIF binding from root (ADR-INFRA-006 §5);
#     submits Cloud Build jobs that run AS the worker.
#   - cortex-ci-migration-{env}: worker. Cloud Build assumes this identity at
#     runtime to read the break-glass secret and connect to Cloud SQL.
#   - cortex-migration-runner: private worker pool peered to env VPC; Cloud SQL
#     private IP is reachable from inside.
#
# This module does NOT create the workloadIdentityUser binding on submit SA —
# that's wired in the env root using outputs from this module + the wif module.
# Cross-module wiring lives at the root.
# ─────────────────────────────────────────────────────────────────────────────

# ─── Cloud Build service agent eager materialization ───────────────────────
# On fresh projects the Cloud Build service agent is materialized lazily on
# first meaningful use, NOT at API enable. IAM grants targeting the agent
# fail until it exists. Same pattern as ADR-INFRA-005 Quirk 1 (Cloud SQL).
# Force materialization, then sleep 60s for IAM propagation.
resource "google_project_service_identity" "cloudbuild" {
  provider = google-beta
  project  = var.project_id
  service  = "cloudbuild.googleapis.com"
}

resource "time_sleep" "cloudbuild_agent_propagation" {
  create_duration = "60s"
  depends_on      = [google_project_service_identity.cloudbuild]
}

# ─── Service accounts ──────────────────────────────────────────────────────
resource "google_service_account" "submit" {
  project      = var.project_id
  account_id   = "cortex-ci-submit-${var.environment}"
  display_name = "Cortex CI submit (${var.environment}) — submits migration builds via WIF"
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "cortex-ci-migration-${var.environment}"
  display_name = "Cortex CI migration worker (${var.environment}) — Cloud Build runs as this identity"
}

# ─── Submit SA → project: cloudbuild.builds.editor ─────────────────────────
resource "google_project_iam_member" "submit_cloudbuild_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.submit.email}"
}

# ─── Submit SA → worker: serviceAccountUser (act-as for build creation) ────
resource "google_service_account_iam_member" "submit_user_on_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.submit.email}"
}

# ─── Worker SA → project: cloudsql.client (Cloud SQL Auth Proxy connect) ───
resource "google_project_iam_member" "worker_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

# ─── Worker SA → project: logging.logWriter (private-pool step logs) ──────
# Required because Cloud Build private pools mandate options.logging:
# CLOUD_LOGGING_ONLY. Without this role the build reports SUCCESS but step
# output is not captured anywhere. See ADR-CI-001 Impl Notes.
resource "google_project_iam_member" "worker_logs_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

# ─── Worker SA → project: storage.objectViewer (read source tarball) ──────
# gcloud builds submit with source upload targets the auto-created
# {project}_cloudbuild bucket. With a custom service account the worker SA
# (not the default Cloud Build SA) must read that object. Project-level chosen
# over bucket-scoped because the bucket is created lazily by gcloud — scoped
# IAM would fail on fresh envs where no build has yet run. See ADR-CI-001
# Impl Notes.
resource "google_project_iam_member" "worker_source_reader" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

# ─── Worker SA → secret: secretAccessor (scoped, NOT project-wide) ─────────
resource "google_secret_manager_secret_iam_member" "worker_secret_accessor" {
  project   = var.project_id
  secret_id = var.break_glass_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

# ─── Cloud Build service agent → worker: serviceAccountTokenCreator ────────
# Required (NOT implicit via cloudbuild.serviceAgent role) for Cloud Build to
# assume the worker identity at build runtime. Per ADR-INFRA-006 Decision 4
# and Impl Notes "Two distinct impersonation roles".
resource "google_service_account_iam_member" "cloudbuild_token_creator_on_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"

  depends_on = [time_sleep.cloudbuild_agent_propagation]
}

# ─── Cloud Build private worker pool, peered to env VPC ────────────────────
# Pool runs in Cloud Build's tenant project; network_config peers the pool's
# tenant VPC to the env's cortex-vpc, allocating worker IPs from the
# customer-reserved cortex-cloudbuild-psa-range (created in networking module).
# Per ADR-CI-001 Decision 1.
resource "google_cloudbuild_worker_pool" "cortex_migration_runner" {
  name     = var.worker_pool_id
  location = var.region
  project  = var.project_id

  worker_config {
    machine_type = var.worker_pool_machine_type
    # Coupled with egress_option: PUBLIC_EGRESS (set out-of-band via
    # `gcloud ... --public-egress`, see Makefile cloud-build-pool-configure-*).
    # Public-egress workers require an external IP; no_external_ip must be false.
    # If egress is ever reverted to NO_PUBLIC_EGRESS, flip this back to true in
    # the same change. See ADR-CI-001 Impl Notes "CRITICAL PROVIDER GAP".
    no_external_ip = false
    disk_size_gb   = var.worker_pool_disk_size_gb
  }

  network_config {
    peered_network          = var.vpc_id
    peered_network_ip_range = var.cloudbuild_psa_range_cidr
  }
}

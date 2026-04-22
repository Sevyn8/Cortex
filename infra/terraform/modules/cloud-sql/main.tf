# ─────────────────────────────────────────────────────────────────────────────
# cloud-sql — Postgres 17 Enterprise instance, private IP, CMEK.
#
# One instance per environment project. Single `cortex` database. No SQL
# users — IAM authentication only. See ADR-INFRA-005 for the full design.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  instance_name = "cortex-${var.environment}-${var.instance_name_suffix}"

  # Cloud SQL service agent email, computed deterministically from the
  # project number. Pattern per ADR-INFRA-002 Quirk 1 — google_project_
  # service_identity returns .email = null for pre-materialized agents,
  # so we compute rather than look up.
  cloudsql_service_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-cloud-sql.iam.gserviceaccount.com"
}

# ─── Project lookup — for project_number ────────────────────────────────────
data "google_project" "this" {
  project_id = var.project_id
}

# ─── Force materialization of Cloud SQL service agent ──────────────────────
#
# The sqladmin.googleapis.com API is enabled in project_baseline, but Cloud SQL's
# service agent (service-<project_number>@gcp-sa-cloud-sql.iam.gserviceaccount.com)
# is materialized lazily on first meaningful use, NOT at API-enable time. Fresh
# projects that have never created a Cloud SQL resource do not have this agent,
# so IAM grants targeting it fail with "Service account does not exist."
#
# This resource forces eager materialization. We use it purely as a trigger —
# the .email attribute is unreliable (see ADR-INFRA-002 Quirk 1), so the CMEK
# grant below computes the service-agent email deterministically from project_number.
#
# See ADR-INFRA-005 Implementation Notes (Quirk 1) for the full story.
resource "google_project_service_identity" "cloudsql" {
  provider = google-beta
  project  = var.project_id
  service  = "sqladmin.googleapis.com"
}

# ─── Wait for IAM propagation of the materialized service agent ────────────
#
# The google_project_service_identity resource above completes in ~3 seconds,
# but IAM propagation of the agent's existence lags by ~30-60 seconds. A CMEK
# grant attempted in the same apply step immediately after identity creation
# fails with "Service account ... does not exist" even though the identity
# resource succeeded.
#
# This is the same class as ADR-INFRA-002 Quirk 2 (PSA first-apply race):
# create call succeeded, but an eventual-consistency side effect has not
# propagated. Without this sleep, the first apply in any fresh project fails
# at the CMEK grant and requires a manual retry.
#
# See ADR-INFRA-005 Quirk 1 for the full analysis.
resource "time_sleep" "cloudsql_agent_propagation" {
  create_duration = "60s"
  depends_on      = [google_project_service_identity.cloudsql]
}

# ─── CMEK service-agent grant ──────────────────────────────────────────────
# Must exist before instance creation. Cloud SQL validates CMEK access
# synchronously at instance create time; missing grant ⇒ create fails.
# Per ADR-INFRA-002 Quirk 5 (CMEK service-agent grant pattern).
resource "google_kms_crypto_key_iam_member" "cloudsql_cmek" {
  crypto_key_id = var.kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.cloudsql_service_agent

  depends_on = [time_sleep.cloudsql_agent_propagation]
}

# ─── Cloud SQL instance ────────────────────────────────────────────────────
resource "google_sql_database_instance" "this" {
  project             = var.project_id
  name                = local.instance_name
  region              = var.region
  database_version    = var.database_version
  deletion_protection = var.deletion_protection

  # Instance-level CMEK reference. Matches the key granted above.
  encryption_key_name = var.kms_key_id

  settings {
    # GCP-side deletion protection (Console / gcloud / API).
    # Terraform-side is the top-level deletion_protection attribute outside settings {}.
    # Both layers on per ADR-INFRA-005 posture — single var controls both.
    deletion_protection_enabled = var.deletion_protection

    tier                  = var.tier
    edition               = var.edition
    availability_type     = var.availability_type
    disk_type             = var.disk_type
    disk_size             = var.disk_size_gb
    disk_autoresize       = var.disk_autoresize
    disk_autoresize_limit = var.disk_autoresize_limit_gb

    # Private IP is always attached. Public IPv4 is opt-in per env (dev only
    # in Phase 1; staging/prod stay false per ADR-INFRA-005 Decision 11).
    ip_configuration {
      ipv4_enabled    = var.public_ip_enabled
      private_network = var.private_network_id

      dynamic "authorized_networks" {
        for_each = var.authorized_networks
        content {
          name  = authorized_networks.value.name
          value = authorized_networks.value.value
        }
      }
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = var.backup_start_time_utc
      transaction_log_retention_days = var.pitr_retention_days

      backup_retention_settings {
        retained_backups = var.backup_retained_count
        retention_unit   = "COUNT"
      }
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    database_flags {
      name  = "max_connections"
      value = tostring(var.max_connections)
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = true
    }

    # Sunday 22:00 UTC = 3:30 AM IST Monday. Stable track lags canary by ~2 weeks.
    maintenance_window {
      day          = 7
      hour         = 22
      update_track = "stable"
    }

    user_labels = var.common_labels
  }

  lifecycle {
    prevent_destroy = true
  }

  # Explicit ordering: the CMEK grant must land before the instance
  # attempts to create, since Cloud SQL validates access at create time.
  depends_on = [google_kms_crypto_key_iam_member.cloudsql_cmek]
}

# ─── Default application database ──────────────────────────────────────────
# Single shared-RLS 'cortex' database per instance (sub-decision A).
# Dedicated per-tenant databases for F01 isolation_mode=DEDICATED tenants
# are created separately by F02 Tenant Lifecycle Manager, not here.
resource "google_sql_database" "default" {
  project  = var.project_id
  instance = google_sql_database_instance.this.name
  name     = var.db_name
}

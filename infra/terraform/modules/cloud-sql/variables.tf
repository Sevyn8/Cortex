variable "project_id" {
  type        = string
  description = "GCP project hosting the Cloud SQL instance. One instance per env project."
}

variable "project_number" {
  type        = number
  description = "GCP project number (read once at env root via data \"google_project\" \"current\", passed down to avoid in-module data-source deferral when other modules with depends_on have pending changes). Used to compute the Cloud SQL service-agent email deterministically. Type number, not string."
}

variable "environment" {
  type        = string
  description = "Environment key. Used as a label value and embedded in the instance name (cortex-<env>-postgres)."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  type        = string
  description = "Primary region for the instance. Matches the VPC region."
  default     = "asia-south1"
}

variable "instance_name_suffix" {
  type        = string
  description = "Suffix appended to the instance name (cortex-<env>-<suffix>). Defaults to 'postgres' — override only if multiple Postgres instances coexist in the same env project, which Phase 1 does not."
  default     = "postgres"
}

variable "database_version" {
  type        = string
  description = "Cloud SQL Postgres version. Phase 1 standard is POSTGRES_17 per ADR-INFRA-005 Decision 2."
  default     = "POSTGRES_17"

  validation {
    condition     = can(regex("^POSTGRES_1[7-9]$", var.database_version))
    error_message = "database_version must be POSTGRES_17 or later."
  }
}

variable "edition" {
  type        = string
  description = "Cloud SQL edition. Phase 1 standard is ENTERPRISE per ADR-INFRA-005 Decision 1. Default is explicit because Postgres 16+ defaults to ENTERPRISE_PLUS at the GCP level."
  default     = "ENTERPRISE"

  validation {
    condition     = contains(["ENTERPRISE", "ENTERPRISE_PLUS"], var.edition)
    error_message = "edition must be ENTERPRISE or ENTERPRISE_PLUS."
  }
}

variable "tier" {
  type        = string
  description = "Machine tier. Phase 1: db-custom-2-8192 for dev/staging, db-custom-4-16384 for prod (ADR-INFRA-005 Decision 4)."
}

variable "availability_type" {
  type        = string
  description = "HA posture. ZONAL for dev/staging, REGIONAL for prod (ADR-INFRA-005 Decision 3)."

  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.availability_type)
    error_message = "availability_type must be ZONAL or REGIONAL."
  }
}

variable "disk_type" {
  type        = string
  description = "Persistent disk type. PD_SSD Phase 1 default."
  default     = "PD_SSD"
}

variable "disk_size_gb" {
  type        = number
  description = "Starting disk size in GB. Autoresize grows it from here."
  default     = 20
}

variable "disk_autoresize" {
  type        = bool
  description = "Whether the disk autoresizes when approaching capacity."
  default     = true
}

variable "disk_autoresize_limit_gb" {
  type        = number
  description = "Upper bound for disk autoresize in GB. 0 means unbounded; default 100 is a Phase 1 guardrail."
  default     = 100
}

variable "backup_retained_count" {
  type        = number
  description = "Number of daily backups retained. Per-env per ADR-INFRA-005 Decision 5: dev 7, staging 7, prod 14."
}

variable "pitr_retention_days" {
  type        = number
  description = "Point-in-time recovery retention in days (transaction-log days). Per-env per ADR-INFRA-005 Decision 5: dev 1, staging 3, prod 7."

  validation {
    condition     = var.pitr_retention_days >= 1 && var.pitr_retention_days <= 7
    error_message = "pitr_retention_days must be between 1 and 7. Cloud SQL Enterprise edition caps transaction-log retention at 7; Enterprise Plus extends this to 35, but Phase 1 is locked to Enterprise per ADR-INFRA-005 Decision 1."
  }
}

variable "backup_start_time_utc" {
  type        = string
  description = "Daily backup window start time, UTC, HH:MM. Phase 1 standard 18:00 UTC (off-hours for India workloads)."
  default     = "18:00"

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]$", var.backup_start_time_utc))
    error_message = "backup_start_time_utc must be HH:MM in 24-hour format."
  }
}

variable "private_network_id" {
  type        = string
  description = "Self-link of the VPC hosting the PSA peering for this env. Instance has private IP only (ipv4_enabled=false)."
}

variable "max_connections" {
  type        = number
  description = "max_connections database flag. Phase 1: 100 for dev/staging, 200 for prod."
}

variable "kms_key_id" {
  type        = string
  description = "Fully-qualified resource name of the CMEK crypto key (cortex-cloudsql-key) in the env's cortex-keyring. Service-agent grant is created inside this module per ADR-INFRA-002 Quirk 5."
}

variable "db_name" {
  type        = string
  description = "Name of the default application database created alongside the instance. Phase 1 standard is 'cortex' — single shared-RLS database. Dedicated per-tenant databases (F01 isolation_mode=DEDICATED) are created separately by F02 Tenant Lifecycle Manager."
  default     = "cortex"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]*$", var.db_name))
    error_message = "db_name must start with a lowercase letter and contain only lowercase letters, digits, and underscores."
  }
}

variable "common_labels" {
  type        = map(string)
  description = "Resource labels. Per Terraform conventions in CLAUDE.md: managed_by, project, environment, prompt."
  default     = {}
}

variable "deletion_protection" {
  type        = bool
  description = "Cloud SQL deletion protection. Defaults to true everywhere; prod apply rejects false. Separate from Terraform lifecycle prevent_destroy — both layers in place for prod."
  default     = true
}

variable "public_ip_enabled" {
  type        = bool
  description = "Whether the instance exposes a public IPv4 address in addition to its private IP. Phase 1 standard is false (private-only per ADR-INFRA-005 Decision 11). Dev may override to true for laptop-based operations during early prompts — see P0.4 Phase B migration workflow. Staging and prod remain false until P0.5 establishes VPC-internal migration runners."
  default     = false
}

variable "authorized_networks" {
  type = list(object({
    name  = string
    value = string
  }))
  description = "CIDR allowlist applied when public_ip_enabled=true. Ignored by Cloud SQL when public_ip_enabled=false. Each entry needs a stable name (for audit traceability in Console) and a narrow CIDR. Do NOT widen to 0.0.0.0/0. Phase 1 use case: dev-only narrow allowlist for a single operator's home IP."
  default     = []
}

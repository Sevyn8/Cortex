variable "project_id" {
  type        = string
  description = "Env GCP project hosting monitoring resources (sevyn8-cortex-{env})."
}

variable "environment" {
  type        = string
  description = "Environment key. Used in display names and for severity routing on Cloud Build failures (CRITICAL in prod, WARNING in dev/staging)."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "cloud_sql_instance_name" {
  type        = string
  description = "Cloud SQL instance name (e.g., cortex-dev-postgres). Used in resource.labels.database_id filter for Cloud SQL alert policies. Module targets a single instance per env."
}

variable "cloud_sql_max_connections" {
  type        = number
  description = "Max connections database flag for the Cloud SQL instance. Dev/staging: 100. Prod: 200. Used to compute the 80%-of-max threshold for the connections-high alert (caller supplies per env; hardcoding the threshold inside the module would couple it to per-env sizing)."

  validation {
    condition     = var.cloud_sql_max_connections > 0
    error_message = "cloud_sql_max_connections must be positive."
  }
}

variable "notification_recipients" {
  type = list(object({
    display_name = string
    email        = string
  }))
  description = "Per-env email recipients. One google_monitoring_notification_channel (type=email) created per recipient, keyed by display_name. Values live in local.auto.tfvars (gitignored) to keep personal identities out of the repo."

  validation {
    condition     = length(var.notification_recipients) >= 1
    error_message = "at least one recipient required."
  }

  validation {
    condition     = length([for r in var.notification_recipients : r.email if can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", r.email))]) == length(var.notification_recipients)
    error_message = "all recipients must have a valid email address."
  }

  validation {
    condition     = length(distinct([for r in var.notification_recipients : r.display_name])) == length(var.notification_recipients)
    error_message = "recipient display_names must be unique (used as for_each keys)."
  }
}

variable "chat_webhook_url" {
  type        = string
  description = "Google Chat incoming webhook URL. Used as labels.url on a webhook_tokenauth notification channel for CRITICAL-only alerts. Sensitive: lives in local.auto.tfvars (gitignored). Terraform's sensitive propagation redacts this in plan output; state-file storage is plaintext (CMEK-encrypted at rest in GCS backend). Rotation: regenerate in Chat space, update local.auto.tfvars, re-apply."
  sensitive   = true

  validation {
    condition     = can(regex("^https://chat\\.googleapis\\.com/v1/spaces/[^/]+/messages\\?", var.chat_webhook_url))
    error_message = "chat_webhook_url must be a Google Chat incoming webhook URL (starts with https://chat.googleapis.com/v1/spaces/<space>/messages?)."
  }
}

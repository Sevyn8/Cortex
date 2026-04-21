variable "project_id" {
  type        = string
  description = "GCP project to create the secret in."
}

variable "secret_id" {
  type        = string
  description = "Secret name following cortex-<category>-<specific-name>. Categories: auth, ai, email, db, webhook, integration, tenant-<tenant-id>, app. See CLAUDE.md Secret Manager naming."

  validation {
    condition = can(regex(
      "^cortex-(auth|ai|email|db|webhook|integration|tenant-[a-z0-9-]+|app)-[a-z0-9-]+$",
      var.secret_id
    ))
    error_message = "secret_id must match ^cortex-<category>-<name>$ where category is one of auth|ai|email|db|webhook|integration|tenant-<id>|app, and <name> is lowercase alphanumeric + hyphens."
  }
}

variable "kms_key_id" {
  type        = string
  description = "Fully-qualified CMEK key ID. Every secret is CMEK-encrypted — no Google-managed-key path."
}

variable "replication_locations" {
  type        = list(string)
  description = "Regions to replicate this secret to. user_managed replication is required for CMEK (automatic replication does not support CMEK)."
  default     = ["asia-south1"]
}

variable "common_labels" {
  type        = map(string)
  description = "Labels applied to the secret."
  default     = {}
}

variable "project_id" {
  type        = string
  description = "GCP project for the keyring."
}

variable "location" {
  type        = string
  description = "KMS location. Must match the region of resources encrypted by these keys."
  default     = "asia-south1"
}

variable "keyring_name" {
  type        = string
  description = "Keyring name. 'cortex-keyring' is the common project keyring; use distinct names for special-purpose rings (e.g., 'cortex-tfstate-keyring')."
}

variable "keys" {
  type        = list(string)
  description = "Key names to create in the keyring. All keys are symmetric ENCRYPT_DECRYPT."
}

variable "rotation_period" {
  type        = string
  description = "Automatic rotation cadence. Default is 90 days per ADR-INFRA-004."
  default     = "7776000s"
}

variable "protection_level" {
  type        = string
  description = "SOFTWARE for Phase 1, HSM for prod post-P11.4 per ADR-INFRA-004."
  default     = "SOFTWARE"

  validation {
    condition     = contains(["SOFTWARE", "HSM"], var.protection_level)
    error_message = "protection_level must be SOFTWARE or HSM."
  }
}

variable "common_labels" {
  type        = map(string)
  description = "Labels applied to each key."
  default     = {}
}

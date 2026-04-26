variable "project_id" {
  type        = string
  description = "GCP project ID for this environment (sevyn8-cortex-{env})."
}

variable "environment" {
  type        = string
  description = "Environment name: dev, staging, or prod. Used in bucket naming and labels."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  type        = string
  description = "GCS bucket location. asia-south1 for Cortex (per ADR-INFRA-003 VPC topology)."
  default     = "asia-south1"
}

variable "gcs_kms_key_id" {
  type        = string
  description = "Fully-qualified KMS key resource id used for bucket-level CMEK. Typically cortex-gcs-key from the env keyring (ADR-INFRA-004 §Decision 5)."
}

variable "common_labels" {
  type        = map(string)
  description = "Common labels to apply to bucket + IAM resources. Merged with module-specific labels (scope, env)."
  default     = {}
}

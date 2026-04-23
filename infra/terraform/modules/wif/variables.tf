variable "project_id" {
  type        = string
  description = "GCP project hosting the WIF pool. Per ADR-INFRA-006 Decision 1: sevyn8-cortex-shared."
}

variable "pool_id" {
  type        = string
  description = "Workload Identity Pool ID. Phase 1 standard: cortex-github-pool."
  default     = "cortex-github-pool"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,31}$", var.pool_id)) && !can(regex("^gcp-", var.pool_id))
    error_message = "pool_id must be 4-32 chars, lowercase letters/digits/hyphens, start with a letter, and must not start with 'gcp-'."
  }
}

variable "pool_display_name" {
  type        = string
  description = "Human-readable display name for the pool. Shown in GCP Console."
  default     = "Cortex GitHub Actions"
}

variable "pool_description" {
  type        = string
  description = "Pool description. Shown in GCP Console; useful for operator context."
  default     = "GitHub Actions OIDC federation for Cortex CI workflows. See ADR-INFRA-006."
}

variable "provider_id" {
  type        = string
  description = "OIDC provider ID within the pool. Phase 1 standard: cortex-github-provider."
  default     = "cortex-github-provider"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,31}$", var.provider_id)) && !can(regex("^gcp-", var.provider_id))
    error_message = "provider_id must be 4-32 chars, lowercase letters/digits/hyphens, start with a letter, and must not start with 'gcp-'."
  }
}

variable "provider_display_name" {
  type        = string
  description = "Human-readable display name for the OIDC provider."
  default     = "GitHub Actions OIDC"
}

variable "repo_full_name" {
  type        = string
  description = "GitHub repository in 'owner/repo' format. Used in the provider attribute_condition to restrict token exchange to this repo only (ADR-INFRA-006 Decision 3)."

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.repo_full_name))
    error_message = "repo_full_name must be 'owner/repo' format (e.g., 'rahul-1974/Cortex')."
  }
}

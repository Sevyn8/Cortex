variable "project_id" {
  type        = string
  description = "GCP project ID for the staging environment."
}

variable "region" {
  type        = string
  description = "Primary region. asia-south1 per v2.2 spec."
}

variable "cidr_octet" {
  type        = number
  description = "Second octet of the 10.X.0.0/16 plan. dev=10, staging=20, prod=30. Consumed by the networking module to derive every subnet CIDR."

  validation {
    condition     = contains([10, 20, 30], var.cidr_octet)
    error_message = "cidr_octet must be 10 (dev), 20 (staging), or 30 (prod)."
  }
}

variable "common_labels" {
  type        = map(string)
  description = "Labels applied to resources that support them. Resource-level only — project-level labels are managed outside Terraform."
}

variable "wif_pool_resource_name" {
  type        = string
  description = "Full resource name of the shared WIF pool (ADR-INFRA-006 Decision 8). Hard-coded in terraform.tfvars rather than read via terraform_remote_state."
}

variable "wif_pool_principal_set_base" {
  type        = string
  description = "principalSet:// base string for the shared WIF pool. Used to compose workloadIdentityUser member bindings."
}

variable "wif_provider_resource_name" {
  type        = string
  description = "Full resource name of the GitHub OIDC provider. Passed to google-github-actions/auth in workflow files."
}

variable "wif_project_number" {
  type        = string
  description = "Project number of sevyn8-cortex-shared. Used for principal-set composition and audit reference."
}

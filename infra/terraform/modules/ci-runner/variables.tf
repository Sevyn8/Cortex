variable "project_id" {
  type        = string
  description = "Env GCP project hosting the CI runner infrastructure (sevyn8-cortex-{env})."
}

variable "project_number" {
  type        = number
  description = "GCP project number (read once at env root via data \"google_project\" \"current\", passed down to avoid in-module data-source deferral when other modules with depends_on have pending changes). Used to compute the Cloud Build service-agent email deterministically. Type number, not string."
}

variable "environment" {
  type        = string
  description = "Environment key. Used in SA + display names."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  type        = string
  description = "Region for the Cloud Build private worker pool. Must match the env VPC region (asia-south1 for Phase 1)."
  default     = "asia-south1"
}

variable "vpc_id" {
  type        = string
  description = "Self-link of the env VPC (e.g., projects/<project>/global/networks/cortex-vpc). Required by Cloud Build private pool's network_config.peered_network."
}

variable "cloudbuild_psa_range_cidr" {
  type        = string
  description = "CIDR of the cortex-cloudbuild-psa-range global address (created by the networking module). Phase 1 standard 10.X.224.0/24. Used as network_config.peered_network_ip_range."

  validation {
    condition     = can(cidrhost(var.cloudbuild_psa_range_cidr, 0))
    error_message = "cloudbuild_psa_range_cidr must be a valid CIDR (e.g., 10.10.224.0/24)."
  }
}

variable "break_glass_secret_id" {
  type        = string
  description = "Short ID of the break-glass Secret Manager secret in this project (e.g., 'cortex-db-postgres-break-glass-dev'). Worker SA gets secretAccessor scoped to this specific secret."
}

variable "worker_pool_machine_type" {
  type        = string
  description = "Machine type for the Cloud Build private worker pool. Phase 1 default e2-medium suffices for migration runs."
  default     = "e2-medium"
}

variable "worker_pool_id" {
  type        = string
  description = "Short ID for the Cloud Build private worker pool."
  default     = "cortex-migration-runner"
}

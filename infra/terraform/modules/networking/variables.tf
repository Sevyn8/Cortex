variable "project_id" {
  type        = string
  description = "GCP project to place the VPC in."
}

variable "environment" {
  type        = string
  description = "Environment key. Used only as a label value and for documentation — the VPC name itself does not include the environment (each env lives in its own project, so no naming collision)."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  type        = string
  description = "Primary region for subnets and regional resources."
  default     = "asia-south1"
}

variable "vpc_name" {
  type        = string
  description = "VPC network name. Default 'cortex-vpc' — consistent across all environments since VPCs are scoped to projects."
  default     = "cortex-vpc"
}

variable "cidr_octet" {
  type        = number
  description = "Second octet of the 10.X.0.0/16 range for this environment. dev=10, staging=20, prod=30. Determines every subnet CIDR."

  validation {
    condition     = contains([10, 20, 30], var.cidr_octet)
    error_message = "cidr_octet must be 10 (dev), 20 (staging), or 30 (prod)."
  }
}

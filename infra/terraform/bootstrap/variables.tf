variable "admin_group" {
  type        = string
  description = "Google Workspace group that holds Cortex operators. Members can impersonate the cortex-tf-admin SAs and read/write Terraform state."
  default     = "cortex-admins@sevyn8.com"
}

variable "region" {
  type        = string
  description = "Primary GCP region. asia-south1 (Mumbai) per v2.2 spec — organization-level compliance region for DPDP alignment."
  default     = "asia-south1"
}

variable "projects" {
  type = map(object({
    project_id     = string
    project_number = string
  }))
  description = "GCP project registry. Keys: dev, staging, prod, tfstate, shared. project_number is used for service-agent email derivation and is committed because it is not a secret."
  default = {
    dev = {
      project_id     = "sevyn8-cortex-dev"
      project_number = "732341182091"
    }
    staging = {
      project_id     = "sevyn8-cortex-staging"
      project_number = "1068369519814"
    }
    prod = {
      project_id     = "sevyn8-cortex-prod"
      project_number = "1049927930827"
    }
    tfstate = {
      project_id     = "sevyn8-cortex-tfstate"
      project_number = "501622945381"
    }
    shared = {
      project_id     = "sevyn8-cortex-shared"
      project_number = "242079866727"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP project ID hosting the signer SA (sevyn8-cortex-{env})."
}

variable "environment" {
  type        = string
  description = "Environment name: dev, staging, or prod. Encoded into the SA's account_id per convention §10.8 — yields cortex-export-signer-{env}."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "runtime_sa_email" {
  type        = string
  description = "Email of the runtime SA that needs roles/iam.serviceAccountTokenCreator on this signer SA. The runtime SA invokes IAM SignBlob to sign as the signer SA when signing tenant export pre-signed URLs (F02 Slice C convention §10.8)."
  validation {
    condition     = can(regex("^[a-zA-Z0-9-]+@[a-zA-Z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.runtime_sa_email))
    error_message = "runtime_sa_email must be a fully-qualified GCP SA email."
  }
}

variable "tenant_data_bucket_name" {
  type        = string
  description = "Name of the tenant-data bucket the signer SA should be able to read (for signed-URL validity once impersonation code lands). Typically module.tenant_data_bucket.bucket_name."
}

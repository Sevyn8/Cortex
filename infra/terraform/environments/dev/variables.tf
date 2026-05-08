variable "project_id" {
  type        = string
  description = "GCP project ID for the dev environment."
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
  description = "Labels applied to resources that support them (KMS keys, buckets, secrets, connectors, etc.). Resource-level only — project-level labels are managed outside Terraform."
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

variable "notification_recipients" {
  type = list(object({
    display_name = string
    email        = string
  }))
  description = "Per-env notification recipients (display_name + email). Values live in local.auto.tfvars (gitignored). Passed to the monitoring module's per-env notification channels. NOT marked sensitive: Terraform forbids for_each over sensitive values, and operator emails aren't credentials (team-visible via Chat/Workspace anyway)."
}

variable "chat_webhook_url" {
  type        = string
  description = "Google Chat incoming webhook URL for the Cortex Alerts space. Lives in local.auto.tfvars (gitignored). Passed to the monitoring module's webhook_tokenauth channel for CRITICAL-route alerts."
  sensitive   = true
}

# ─── F02 Slice D D.4 additions ─────────────────────────────────────────────

variable "shared_project_id" {
  type        = string
  default     = "sevyn8-cortex-shared"
  description = "Project hosting the shared Artifact Registry (cortex-apps, cortex-agents, cortex-mcp). Used for cross-project IAM grants letting per-env runtime SAs pull images."
}

variable "operator_emails" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Operator emails granted roles/iam.serviceAccountUser on
    tenant-lifecycle-runtime for break-glass deploys (e.g.,
    `gcloud run deploy --service-account=tenant-lifecycle-runtime@...`).
    Phase 1 reconciliation per D.4: the binding D.1 created via gcloud
    is now declared here. Operator rotation = edit this list. Lives in
    local.auto.tfvars (gitignored) since team membership shouldn't be
    in version control.
  EOT
}

variable "tenant_lifecycle_image_uri" {
  type        = string
  default     = ""
  description = <<-EOT
    Fully-qualified container image URI for the tenant-lifecycle-shared
    Cloud Run service. Empty default = lets operator set via
    local.auto.tfvars; the tenant-cloud-run-service module's
    `lifecycle.ignore_changes = [image]` preserves out-of-band
    deploy-script-pushed images on subsequent applies.
    Format:
      asia-south1-docker.pkg.dev/sevyn8-cortex-shared/cortex-apps/tenant-lifecycle-api:sha-<git-sha>
  EOT
}

variable "tenant_lifecycle_service_url" {
  type        = string
  default     = ""
  description = <<-EOT
    Cloud Run v2 service URL for tenant-lifecycle-shared. The dispatcher
    + worker live in the same service (self-reference), so the create /
    offboard / terminate APIs need PROVISIONING_WORKER_URL +
    LIFECYCLE_WORKER_URL pointing back at this same service.

    Cloud Run v2 URLs are stable per (project, region, service-name) —
    once the first revision lands, the URL is permanent for that
    service's lifetime. Operator pastes it into local.auto.tfvars after
    bootstrap deploy. Empty default = the env vars are omitted (the
    POST /v1/tenants path will 500 with the upstream "X_WORKER_URL env
    required" error rather than silently mis-dispatching). Format:
      https://tenant-lifecycle-shared-<hash>-<region>.a.run.app
  EOT
}

variable "project_id" {
  type        = string
  description = "GCP project ID hosting the service (sevyn8-cortex-{env})."
}

variable "location" {
  type        = string
  description = "Cloud Run region. Cortex uses asia-south1 per ADR-INFRA-003."
  default     = "asia-south1"
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.location))
    error_message = "location must be a GCP region slug (e.g., asia-south1)."
  }
}

variable "environment" {
  type        = string
  description = "Environment slug (dev | staging | prod). Used in service labels."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "mode" {
  type        = string
  description = <<-EOT
    Service deployment shape per ADR-COMPUTE-001 + Q-NEW-D-10:
      - "shared"  → service name is `{workload}-shared` (one service per env;
                    STANDARD-tier tenants share). Slice D wires this only.
      - "tenant"  → service name is `{workload}-tenant-{tenant_id}` (one
                    service per ENTERPRISE tenant). Module supports the shape
                    today; per-tenant deploys land post-ADR-INFRA-005 swap.
  EOT
  validation {
    condition     = contains(["shared", "tenant"], var.mode)
    error_message = "mode must be one of: shared, tenant."
  }
}

variable "workload" {
  type        = string
  description = <<-EOT
    Workload short-name (e.g., `tenant-lifecycle`). Used in the service name
    per ADR-COMPUTE-001 §3 service-name format. Cap at 19 chars: the
    `{workload}-tenant-{uuid}` shape uses 19 + 8 + 36 = 63 exactly at the
    Cloud Run service-name limit, so longer workloads can't deploy under
    tenant mode without renaming.
  EOT
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,18}$", var.workload))
    error_message = "workload must be ≤19 chars: lowercase + digits + hyphens, starting with a letter."
  }
}

variable "tenant_id" {
  type        = string
  default     = null
  description = <<-EOT
    Required when `mode = "tenant"`; ignored when `mode = "shared"`. UUID
    format. Embedded in the service name per ADR-COMPUTE-001 §3.
  EOT
  validation {
    condition     = var.tenant_id == null || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.tenant_id))
    error_message = "tenant_id must be a UUID (lowercase hex) when provided."
  }
}

variable "image_uri" {
  type        = string
  description = <<-EOT
    Fully-qualified container image URI (e.g.,
    `asia-south1-docker.pkg.dev/<shared>/cortex-apps/tenant-lifecycle-api:sha-abc1234`).
    Cloud Run service references SHA-tagged images per CLAUDE.md §"Image
    tagging" — immutable, deterministic deploys.
  EOT
}

variable "runtime_sa_email" {
  type        = string
  description = <<-EOT
    Email of the runtime service account the Cloud Run service runs as.
    Per Q-NEW-D-11 (Option 1 lock) the same SA is used both for runtime
    identity AND as the Cloud Tasks invoker / OIDC audience for inbound
    worker calls — Phase 1 simplification; AC01 may split when per-method
    authz arrives.
  EOT
  validation {
    condition     = can(regex("^[a-zA-Z0-9-]+@[a-zA-Z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.runtime_sa_email))
    error_message = "runtime_sa_email must be a fully-qualified GCP SA email."
  }
}

variable "cloudsql_instance_connection_name" {
  type        = string
  description = <<-EOT
    Cloud SQL instance connection name (`project:region:instance`). Cloud Run
    mounts the Cloud SQL Auth Proxy socket at /cloudsql/{this value}; the
    app reads it from the CLOUDSQL_INSTANCE_CONNECTION_NAME env var.
  EOT
  validation {
    condition     = can(regex("^[^:]+:[^:]+:[^:]+$", var.cloudsql_instance_connection_name))
    error_message = "cloudsql_instance_connection_name must match project:region:instance."
  }
}

variable "vpc_connector_id" {
  type        = string
  description = <<-EOT
    Fully-qualified VPC access connector resource name. Required so Cloud
    Run instances can reach Cloud SQL's private IP (and any other
    private-range targets). Pass `module.networking.vpc_connector_id`
    from env-level main.tf — the cortex-connector connector created by
    the networking module on each env's VPC. Module wires it into the
    Cloud Run service via `vpc_access.connector` with
    `egress = PRIVATE_RANGES_ONLY` (private-range traffic only; public
    API egress stays on the default Google path).
  EOT
}

variable "min_instances" {
  type        = number
  description = <<-EOT
    Cloud Run min_instances per `tenant-lifecycle-convention.md` §7.1:
    dev = 0 (cold-start observability + cost-conscious),
    staging = 1, prod = 1 (eliminate platform-cold-start from operator hot
    path). Per-env wiring decides; module enforces the value supplied.
  EOT
  validation {
    condition     = var.min_instances >= 0 && var.min_instances <= 100
    error_message = "min_instances must be in [0, 100]."
  }
}

variable "max_instances" {
  type        = number
  default     = 10
  description = "Cloud Run max_instances. Phase 1 ceiling; Phase 2+ traffic-driven re-tune."
}

variable "cpu" {
  type        = string
  default     = "1"
  description = "vCPU per instance. Phase 1 baseline = 1 vCPU."
}

variable "memory" {
  type        = string
  default     = "512Mi"
  description = "Memory per instance. Phase 1 baseline = 512Mi (Hono + dep tree fits comfortably; cold-start measured at ~150ms framework-attributable per ADR-HTTP-001 Condition 2)."
}

variable "concurrency" {
  type        = number
  default     = 80
  description = "Per-instance request concurrency. Cloud Run default."
}

variable "timeout_seconds" {
  type        = number
  default     = 60
  description = "Per-request timeout. 60s default; lifecycle workflows that exceed run via Cloud Tasks worker, not the user-facing request path."
}

variable "common_labels" {
  type        = map(string)
  default     = {}
  description = <<-EOT
    Workspace common labels (managed_by, project, environment, prompt).
    Module merges with workload + placement + tenant_id (when mode=tenant)
    labels per ADR-COMPUTE-001 §4. Label values are GCP-format compliant
    (lowercase + digits + underscores + hyphens; NO periods — see D.1
    deploy-label fix lesson).
  EOT
}

variable "extra_env_vars" {
  type        = map(string)
  default     = {}
  description = <<-EOT
    Plain-value env vars merged on top of the module's required set
    (CLOUDSQL_INSTANCE_CONNECTION_NAME, PG_IAM_USER, PGDATABASE,
    GCP_PROJECT_ID, NODE_ENV, COMMIT_SHA, CLOUD_TASKS_INVOKER_SA_EMAIL).
    Use for app-specific config (e.g., LIFECYCLE_WORKER_URL,
    PROVISIONING_WORKER_URL) — wired per env in env-level main.tf.
  EOT
}

variable "secret_env_vars" {
  type = list(object({
    name        = string
    secret_name = string
    version     = optional(string, "latest")
  }))
  default     = []
  description = <<-EOT
    Secret Manager env vars. Each entry maps a Cloud Run env var to a
    Secret Manager secret version. Phase 1: empty by default — Cloud SQL
    IAM auth replaces the password-based pattern; no PG-credential
    secrets needed. Future workloads with API keys / OAuth client secrets
    populate this.
  EOT
}

variable "invoker_service_accounts" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Service-account emails granted `roles/run.invoker` on this Cloud
    Run service. Phase 1 invoker IAM allowlist per planning-doc SD8 +
    F02 Slice D D.5 — deny-by-default at the Cloud Run platform layer;
    explicit allowlist of caller identities. Empty list = no SA
    invokers (combined with empty `invoker_user_emails`, the service
    is fully unreachable; both lists empty is operationally pointless
    and indicates a wiring error). Typical members:
      - `cortex-tf-admin-{env}` — operator + integration-test path
      - Cloud Tasks dispatcher SA(s) — for worker routes (Phase 1
        uses the runtime SA per Q-NEW-D-11; not added here unless the
        dispatcher splits)
    Per-method authz lands in AC01 (P2.1); Phase 1 tops out at
    invoker-level auth.
  EOT
}

variable "invoker_user_emails" {
  type        = list(string)
  default     = []
  description = <<-EOT
    User emails granted `roles/run.invoker` on this Cloud Run service.
    Operator break-glass identities. Mirrors the `operator_emails`
    pattern from D.4's `lifecycle_runtime_operator_user` binding.
    Empty list = no user invokers. Typical use: lets the on-call
    operator hit /health + lifecycle endpoints from `gcloud auth
    print-identity-token` without minting an impersonation token.
  EOT
}

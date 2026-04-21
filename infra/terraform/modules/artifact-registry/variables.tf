variable "project_id" {
  type        = string
  description = "GCP project to place the repositories in. In Phase 1 this is sevyn8-cortex-shared — one registry plane serves all environments."
}

variable "location" {
  type        = string
  description = "Artifact Registry location. Must match CMEK key location. asia-south1 per v2.2 spec."
  default     = "asia-south1"
}

variable "repositories" {
  type = list(object({
    repository_id = string
    description   = string
  }))
  description = "Repositories to create. All are DOCKER format. Names: cortex-apps, cortex-agents, cortex-mcp per P0.3 scope."

  validation {
    condition     = length(var.repositories) > 0
    error_message = "At least one repository must be declared."
  }

  validation {
    condition = alltrue([
      for r in var.repositories :
      can(regex("^cortex-[a-z0-9-]+$", r.repository_id))
    ])
    error_message = "repository_id must match ^cortex-[a-z0-9-]+$ (e.g., cortex-apps)."
  }
}

variable "kms_key_id" {
  type        = string
  description = "Fully-qualified CMEK key ID. All repositories use the same key."
}

variable "reader_members" {
  type        = list(string)
  description = "IAM members granted roles/artifactregistry.reader on each repo. Use serviceAccount: or group: prefixes. Typical set: env tf-admin SAs (for Terraform-managed pulls) plus env runtime SAs (added per-module later)."
  default     = []
}

variable "immutable_tags" {
  type        = bool
  description = "If true, immutable tags prevent overwriting a tag once pushed. Default true — matches 'environment-tagged versions are kept' cleanup policy."
  default     = true
}

variable "common_labels" {
  type        = map(string)
  description = "Labels applied to each repository."
  default     = {}
}

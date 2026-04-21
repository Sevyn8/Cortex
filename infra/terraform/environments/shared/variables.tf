variable "project_id" {
  type        = string
  description = "GCP project ID for the shared plane (sevyn8-cortex-shared). Hosts Artifact Registry for all environments."
}

variable "region" {
  type        = string
  description = "Primary region. Must match the bootstrap keyring location for CMEK compatibility."
}

variable "kms_key_id" {
  type        = string
  description = "Fully-qualified resource ID of the bootstrap-created Artifact Registry CMEK key in shared's keyring. If the keyring or key name ever changes in bootstrap/locals.tf, this value must update in lock-step."
}

variable "env_tf_admin_emails" {
  type        = list(string)
  description = "Bare email addresses (no serviceAccount: prefix) of each env's cortex-tf-admin SA. main.tf adds the prefix and passes to the artifact-registry module's reader_members input. These are the identities that pull images during env Terraform applies; Cloud Run runtime SAs get narrower per-service reader grants later."
}

variable "common_labels" {
  type        = map(string)
  description = "Labels applied to the artifact registry repositories and any other labelable resources."
}

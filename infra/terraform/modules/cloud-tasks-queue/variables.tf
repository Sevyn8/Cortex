variable "project_id" {
  type        = string
  description = "GCP project ID hosting the queue (sevyn8-cortex-{env})."
}

variable "location" {
  type        = string
  description = "Cloud Tasks region. Cortex uses asia-south1 per ADR-INFRA-003."
  default     = "asia-south1"
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.location))
    error_message = "location must be a GCP region slug (e.g., asia-south1)."
  }
}

variable "queue_name" {
  type        = string
  description = "Queue name within the project/location. Cortex convention: '{verb-or-domain}-queue' (e.g., 'provisioning-queue', 'lifecycle-queue', 'key-rotation-queue')."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.queue_name))
    error_message = "queue_name must be lowercase alphanumeric + hyphens, starting with a letter."
  }
}

variable "max_dispatches_per_second" {
  type        = number
  default     = 10
  description = "Max sustained dispatch rate (Cloud Tasks token-bucket). Default 10/s; raise only when a workflow's traffic profile demands."
}

variable "max_concurrent_dispatches" {
  type        = number
  default     = 10
  description = "Max concurrent in-flight task dispatches. Default 10 per planning-doc Q-OPEN-1 — provisioning is 5-30 min per task; >10 risks DB connection-pool exhaustion."
}

variable "max_attempts" {
  type        = number
  default     = 5
  description = "Max retry attempts before the task hits dead-letter (per ADR-LIFECYCLE-001 §2 + Q-OPEN-1)."
}

variable "min_backoff" {
  type        = string
  default     = "10s"
  description = "Minimum backoff between retries. With max_doublings=5 + max_backoff=300s, the schedule is 10s → 20s → 40s → 80s → 160s → 300s (capped)."
}

variable "max_backoff" {
  type        = string
  default     = "300s"
  description = "Max backoff between retries (5 minutes). Cap reached after max_doublings backoff doublings."
}

variable "max_doublings" {
  type        = number
  default     = 5
  description = "Number of times min_backoff doubles before plateauing at max_backoff."
}

variable "dispatcher_service_account" {
  type        = string
  description = "Email of the service account that needs roles/cloudtasks.enqueuer on this queue (the SA that calls dispatchCloudTask). F02 Slice C sub-phase 7.6 lands per-env wiring (provisioning-queue + lifecycle-queue) using tenant-lifecycle-runtime as the dispatcher; the previously-cited Slice D dependency was lifted by Q-NEW-C1 (Slice C audit) which introduced the runtime SA inline in env main.tf without the worker Cloud Run service."
  validation {
    condition     = can(regex("^[a-zA-Z0-9-]+@[a-zA-Z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.dispatcher_service_account))
    error_message = "dispatcher_service_account must be a fully-qualified GCP SA email."
  }
}

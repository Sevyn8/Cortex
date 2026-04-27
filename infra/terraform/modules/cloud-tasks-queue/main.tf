# ─────────────────────────────────────────────────────────────────────────────
# cloud-tasks-queue — generic Cloud Tasks queue for F02 lifecycle workflows.
#
# Single module instantiated per queue type per env. Slice A wires
# `provisioning-queue` first; Slices B/C/D add `lifecycle-queue` and
# `key-rotation-queue` using the same module.
#
# Defaults match planning-doc Q-OPEN-1 + ADR-LIFECYCLE-001 §2:
# - max_attempts=5, exponential backoff (10s → 5min cap), max_doublings=5.
# - max_concurrent_dispatches=10 (per Q-OPEN-1; each provisioning is
#   5-30 min, >10 risks DB connection-pool exhaustion).
# - max_dispatches_per_second=10 (Cloud Tasks default; sufficient at
#   Phase 1 volume).
#
# Dispatcher IAM: the supplied `dispatcher_service_account` gets
# `roles/cloudtasks.enqueuer` on this queue, letting it call
# `client.createTask(...)`. Worker invocation IAM (the SA that Cloud
# Tasks runs the HTTP target as) is configured per-task at dispatch
# time via `oidc_token.service_account_email` — that grant lands at
# the worker's Cloud Run module, NOT here.
#
# API requirement: callers must enable `cloudtasks.googleapis.com` in
# the project-baseline activate_apis list before this module applies.
# Slice A's project-baseline edit adds the API across all envs.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_cloud_tasks_queue" "this" {
  project  = var.project_id
  location = var.location
  name     = var.queue_name

  rate_limits {
    max_dispatches_per_second = var.max_dispatches_per_second
    max_concurrent_dispatches = var.max_concurrent_dispatches
  }

  retry_config {
    max_attempts  = var.max_attempts
    min_backoff   = var.min_backoff
    max_backoff   = var.max_backoff
    max_doublings = var.max_doublings
  }
}

# Dispatcher SA gets enqueuer role on this queue. Use IAM member
# (additive) per CLAUDE.md TF conventions — never iam_policy
# (authoritative; would overwrite other bindings).
resource "google_cloud_tasks_queue_iam_member" "enqueuer" {
  project  = google_cloud_tasks_queue.this.project
  location = google_cloud_tasks_queue.this.location
  name     = google_cloud_tasks_queue.this.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${var.dispatcher_service_account}"
}

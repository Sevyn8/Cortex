# cloud-tasks-queue

Generic Cloud Tasks queue module for F02 lifecycle workflows.

## Usage

Instantiated once per queue type per env. Defaults match planning-doc
Q-OPEN-1 + ADR-LIFECYCLE-001 §2.

```hcl
module "provisioning_queue" {
  source = "../../modules/cloud-tasks-queue"

  project_id                 = var.project_id
  location                   = var.region # asia-south1 per ADR-INFRA-003
  queue_name                 = "provisioning-queue"
  dispatcher_service_account = module.foundation.runtime_sa_email
}
```

## Slice A deferral

**This module is authored by F02 Slice A (sub-phase 8) but is NOT
instantiated per env yet.** Reason: the `dispatcher_service_account`
is the foundation Cloud Run runtime SA — the identity that will run
the `tenants.provision` HTTP API endpoint and call `dispatchCloudTask`.
That SA is created alongside the worker Cloud Run service in Slice D.

Until Slice D ships:

- Test code mocks `dispatchCloudTask` via `__setClientForTesting`
  per planning-doc SA4 (no real Cloud Tasks dispatch in tests).
- The `cloudtasks.googleapis.com` API IS enabled per env (Slice A
  added it to project-baseline) so the queue can be created the
  moment the dispatcher SA exists.

Slice D's expected sequence:

1. Provision the foundation runtime SA (`tenant-context-runtime` or
   similar — naming TBD per Slice D).
2. Instantiate `module "provisioning_queue"` in each env's `main.tf`
   with the new SA's email.
3. Configure `PROVISIONING_WORKER_URL` env var on the worker Cloud
   Run service.
4. Grant the dispatcher SA `roles/run.invoker` on the worker service
   (so Cloud Tasks can OIDC-auth as the dispatcher to invoke the
   worker — pattern per ADR-INFRA-006 WIF identity layer).

## Inputs

| Variable                     | Required | Default       | Description                                                                                       |
| ---------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `project_id`                 | yes      | —             | GCP project ID (`sevyn8-cortex-{env}`).                                                           |
| `location`                   | no       | `asia-south1` | Cloud Tasks region. Default per ADR-INFRA-003.                                                    |
| `queue_name`                 | yes      | —             | Queue name (e.g., `provisioning-queue`).                                                          |
| `max_dispatches_per_second`  | no       | `10`          | Sustained dispatch rate.                                                                          |
| `max_concurrent_dispatches`  | no       | `10`          | Max in-flight task dispatches per Q-OPEN-1.                                                       |
| `max_attempts`               | no       | `5`           | Retry attempts before dead-letter per Q-OPEN-1.                                                   |
| `min_backoff`                | no       | `10s`         | Min backoff between retries.                                                                      |
| `max_backoff`                | no       | `300s`        | Max backoff cap (5 min).                                                                          |
| `max_doublings`              | no       | `5`           | Backoff doublings before plateau.                                                                 |
| `dispatcher_service_account` | yes      | —             | SA email needing `roles/cloudtasks.enqueuer`. Email-validated by zod-style regex on the variable. |

## Outputs

| Output       | Description                                                         |
| ------------ | ------------------------------------------------------------------- |
| `queue_id`   | Full resource ID `projects/{p}/locations/{l}/queues/{n}`.           |
| `queue_name` | Queue name (without prefix).                                        |
| `queue_path` | Same as `queue_id` but assembled deterministically from input vars. |

## Dead-letter handling

Cloud Tasks does not have a native dead-letter queue feature in
google-cloud-tasks v2 — when a task exceeds `max_attempts`, it is
permanently failed and removed. Operator visibility comes from:

- Cloud Logging entries for failed task executions
  (`logName=cloudtasks.googleapis.com/queue_logs`).
- Cloud Monitoring alert on
  `cloudtasks.googleapis.com/queue/task_attempt_count` filtered by
  `attempt_status="permanently_failed"` (P0.6 observability stack
  delivers; alert config lives outside this module).

Convention doc §8.5 documents the operator triage runbook for
permanently-failed tasks.

## References

- ADR-LIFECYCLE-001 §2 (Cloud Tasks orchestration).
- Planning-doc Q-OPEN-1 (queue config defaults).
- `docs/architecture/tenant-lifecycle-convention.md` §2 (operational
  patterns, dispatcher contract, dead-letter handling).
- `packages/tenant-context/src/cloud-tasks.ts` (the SDK client +
  dispatch utility consuming this queue).

/**
 * Cloud Tasks dispatch utility for F02 lifecycle workflows.
 *
 * Per planning-doc SA9 (locked 2026-04-27): inline utility in
 * `@cortex/tenant-context` rather than a separate
 * `@cortex/cloud-tasks-client` package. F02 is the first Cloud Tasks
 * consumer; abstraction risks designing the wrong API. Slice B/C/D add
 * `lifecycle-queue` and `key-rotation-queue` (per Q-OPEN-1) and will
 * inform whether a separate package is justified.
 *
 * Three queues per Q-OPEN-1:
 *   - `provisioning-queue` — F02 Slice A `tenants.provision`.
 *   - `lifecycle-queue` — F02 Slice B/C `tenants.{suspend,resume,offboard,terminate}`.
 *   - `key-rotation-queue` — F02 Slice D `tenants.rotateKeys`.
 *
 * Idempotency: Cloud Tasks `taskId` provides built-in dedup
 * (~1-hour window). Caller supplies `taskId = '<verb>-<tenant-id>'`
 * per planning-doc D5.
 *
 * Project + location are sourced from env (`GCP_PROJECT_ID`,
 * `GCP_LOCATION` with `asia-south1` fallback). Caller supplies the
 * worker's HTTP endpoint per dispatch (different verbs route to
 * different endpoints once Slice D ships the HTTP API; for Slice A,
 * the provisioning worker URL comes from `PROVISIONING_WORKER_URL`).
 */

import { CloudTasksClient } from '@google-cloud/tasks';

const DEFAULT_LOCATION = 'asia-south1';

let cachedClient: CloudTasksClient | null = null;

function getClient(): CloudTasksClient {
  cachedClient ??= new CloudTasksClient();
  return cachedClient;
}

/**
 * @internal Test-only: inject a mock client. Pass `null` to reset.
 * Mirrors the `__set*ForTesting` convention from `@cortex/secrets`,
 * `@cortex/audit-events`, etc.
 */
export function __setClientForTesting(client: CloudTasksClient | null): void {
  cachedClient = client;
}

export type ProvisioningQueueName = 'provisioning-queue' | 'lifecycle-queue' | 'key-rotation-queue';

export interface DispatchOptions {
  /** Which Cortex queue to enqueue into. */
  queueName: ProvisioningQueueName;
  /**
   * Cloud Tasks taskId for built-in dedup. Format:
   * `'<verb>-<tenant-id>'` per planning-doc D5 (e.g.,
   * `'provisioning-{uuid}'`, `'termination-{uuid}'`). Duplicate
   * taskIds within the dedup window (~1h) are rejected by Cloud
   * Tasks; the rejection is non-fatal (caller treats it as "already
   * enqueued" success).
   */
  taskId: string;
  /** HTTP target URL — the worker's endpoint that Cloud Tasks invokes. */
  targetUrl: string;
  /** JSON-serializable payload; base64-encoded into the request body. */
  payload: Record<string, unknown>;
}

/**
 * Enqueue a task on the named Cortex Cloud Tasks queue.
 *
 * @throws Error if `GCP_PROJECT_ID` env is missing.
 * @throws Error from the Cloud Tasks SDK on dispatch failure (network,
 *   IAM, queue-not-found, etc.). Caller decides retry policy.
 */
export async function dispatchCloudTask(opts: DispatchOptions): Promise<void> {
  const projectId = process.env.GCP_PROJECT_ID;
  if (projectId === undefined || projectId === '') {
    throw new Error('GCP_PROJECT_ID env required for Cloud Tasks dispatch');
  }
  const location = process.env.GCP_LOCATION ?? DEFAULT_LOCATION;
  const client = getClient();
  const queuePath = client.queuePath(projectId, location, opts.queueName);
  const taskName = client.taskPath(projectId, location, opts.queueName, opts.taskId);

  await client.createTask({
    parent: queuePath,
    task: {
      name: taskName,
      httpRequest: {
        httpMethod: 'POST',
        url: opts.targetUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(opts.payload)).toString('base64'),
      },
    },
  });
}

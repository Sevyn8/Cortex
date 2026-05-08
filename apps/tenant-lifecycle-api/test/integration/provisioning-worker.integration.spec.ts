/**
 * Integration test: provisioning worker end-to-end (F02 Slice D D.4.5).
 *
 * Exercises the live Cloud Tasks → Cloud Run dispatch chain:
 *   1. POST /v1/tenants  →  201 with tenant_id (status PROVISIONING)
 *   2. tenants.provision enqueues a task on `provisioning-queue` with
 *      snake_case wire payload + `taskId='provisioning-{uuid}'`.
 *   3. Cloud Tasks dispatches HTTP POST to /v1/_workers/provisioning
 *      with the runtime SA's OIDC ID token.
 *   4. Worker route validates OIDC + body schema, calls
 *      `provisioningWorker(db, payload)` from `@cortex/tenant-context`.
 *   5. Worker advances PROVISIONING → READY → ACTIVE per ALLOWED_TRANSITIONS;
 *      emits TENANT_STATUS_CHANGED per transition + TENANT_PROVISIONED
 *      at READY.
 *   6. Test polls GET /v1/tenants/:id until status === 'ACTIVE'
 *      (or timeout 90s).
 *
 * Skipped unless CORTEX_INTEGRATION_TESTS=true is set. Requires:
 *   - gcloud CLI on PATH + active auth (`gcloud auth login` once
 *     per session for the user identity grant from D.5).
 *   - CORTEX_TENANT_LIFECYCLE_URL env var set to live Cloud Run URL.
 *
 * Proves D.5's runtime-SA invoker grant works end-to-end (Cloud
 * Tasks → Cloud Run → handler), which D.5's gate evidence asserted
 * structurally but couldn't exercise without the worker route.
 */
import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const SKIP = !process.env.CORTEX_INTEGRATION_TESTS;
const SERVICE_URL = process.env.CORTEX_TENANT_LIFECYCLE_URL;

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90_000;

function mintUserIdentityToken(): string {
  return execSync('gcloud auth print-identity-token', { encoding: 'utf8' }).trim();
}

interface TenantRow {
  id: string;
  status: string;
  external_id: string;
}

async function fetchTenant(token: string, tenantId: string): Promise<TenantRow> {
  const res = await fetch(`${SERVICE_URL}/v1/tenants/${tenantId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/tenants/${tenantId} → ${res.status}`);
  }
  return (await res.json()) as TenantRow;
}

async function pollUntilActive(token: string, tenantId: string): Promise<TenantRow> {
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    const tenant = await fetchTenant(token, tenantId);
    if (tenant.status === 'ACTIVE') return tenant;
    if (tenant.status === 'TERMINATED') {
      throw new Error(`tenant ${tenantId} reached TERMINATED — provisioning failed + cleaned up`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const final = await fetchTenant(token, tenantId);
  throw new Error(
    `tenant ${tenantId} did not reach ACTIVE within ${POLL_TIMEOUT_MS}ms; ` +
      `final status=${final.status}`,
  );
}

describe.skipIf(SKIP)('integration: provisioning worker end-to-end (D.4.5)', () => {
  if (!SKIP && !SERVICE_URL) {
    throw new Error('CORTEX_TENANT_LIFECYCLE_URL must be set when CORTEX_INTEGRATION_TESTS=1');
  }

  const createdTenantIds: string[] = [];

  afterAll(() => {
    if (createdTenantIds.length > 0) {
      // Test tenants accumulate; manual cleanup via psql break-glass
      // documented in d4.5-gate-evidence.md §Cleanup. Cloud Tasks dedup
      // (~1h) means re-running this test in quick succession with the
      // same external_id produces a 409 — RUN_TAG randomization avoids
      // collision.
      // eslint-disable-next-line no-console
      console.log('Created tenant ids during integration run:', createdTenantIds.join(', '));
    }
  });

  it(
    'POST /v1/tenants → poll → tenant transitions to ACTIVE within timeout',
    async () => {
      const token = mintUserIdentityToken();
      const externalId = `d4-5-int-${Date.now()}`;

      const createRes = await fetch(`${SERVICE_URL}/v1/tenants`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          external_id: externalId,
          display_name: 'D.4.5 integration test',
          tier: 'STANDARD',
        }),
      });

      expect(createRes.status).toBe(202);
      const created = (await createRes.json()) as { tenant_id: string; status: string };
      expect(created.tenant_id).toMatch(/^[0-9a-f]{8}-/);
      expect(created.status).toBe('PROVISIONING');
      createdTenantIds.push(created.tenant_id);

      const final = await pollUntilActive(token, created.tenant_id);
      expect(final.status).toBe('ACTIVE');
      expect(final.external_id).toBe(externalId);
    },
    POLL_TIMEOUT_MS + 30_000,
  );
});

/**
 * POST /v1/tenants/:id/offboard.
 *
 * SKIPPED. tenants.offboard requires LIFECYCLE_WORKER_URL +
 * dispatches a real Cloud Tasks task + generates a GCS archive.
 * The library tests in packages/tenant-context/test/offboard.spec.ts
 * cover the workflow end-to-end with stubs; replicating against
 * live deps in the HTTP wrapper is over-redundant. The route is
 * structurally identical to suspend/resume — same wiring pattern,
 * same error mapping (suspend.spec.ts + resume.spec.ts cover the
 * wrapper-layer correctness invariant).
 *
 * D.4's deploy smoke test will exercise this end-to-end against
 * the live Cloud Tasks queue + GCS bucket.
 */
import { describe, it } from 'vitest';

describe('POST /v1/tenants/:id/offboard', () => {
  it.skip('happy + error mapping covered at library layer; D.4 smoke covers HTTP wrapper end-to-end', () => {
    // Intentionally empty — see file header for rationale.
  });
});

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
 * D.4.5 gate evidence (`docs/planning/d4.5-gate-evidence.md`)
 * captures the live offboard happy-path against the real Cloud
 * Run service. The unit-test skip stays because GCS lacks a
 * client-factory mock seam (KMS-style `__setClientFactoryForTesting`
 * pattern not yet replicated in `@cortex/blob-storage`); a route-
 * level `cascadeOverrides?` DI seam was considered + deferred at
 * D.4.5 HOLD-#2 reconciliation per Option B (keep-skip + live-
 * integration-only).
 */
import { describe, it } from 'vitest';

describe('POST /v1/tenants/:id/offboard', () => {
  it.skip('happy + error mapping covered at library layer; D.4.5 live integration covers HTTP wrapper end-to-end', () => {
    // Intentionally empty — see file header for rationale.
  });
});

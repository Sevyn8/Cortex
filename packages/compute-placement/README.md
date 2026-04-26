# @cortex/compute-placement

Stub resolver for tenant compute placement. Returns the Cloud Run
service for a `(tenantId, workload, env)` triple per the model
established in ADR-COMPUTE-001 (Cortex runs on Cloud Run, not K8s).

This package is part of F01 Slice C. Phase 1 always returns `'shared'`
placement (no real ENTERPRISE tenants exist yet). F02 will swap the
resolver to consult `tenant.tier` and return `'dedicated'` for
ENTERPRISE-tier tenants — purely additive, no API surface change.

## References

- `docs/architecture/decisions/ADR-COMPUTE-001-cloud-run-vs-k8s-compute-isolation.md` — the canonical placement model
- `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md` — slice scope
- F01 build prompt §3 (compute isolation requirements)

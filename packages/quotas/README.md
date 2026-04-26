# @cortex/quotas

Token-bucket quota enforcement for tenant-scoped resource classes —
backed by `tenant_quota_usage` (control plane, RLS-protected). Issues
429 with `Retry-After` on exceedance; emits `QUOTA_EXCEEDED` audit
events into the SHA-chained `audit_event` table on every rejection.

This package is part of F01 Slice C. Sub-phase 2 (this commit) ships
the scaffold + types + errors + zod schemas only — the token-bucket
runtime (`checkQuota`) lands in sub-phase 3, the catalog + middleware
in sub-phase 4.

## References

- `docs/planning/f01-slice-c-quotas-compute-isolation-scope.md` — slice scope
- `docs/architecture/decisions/ADR-COMPUTE-001-cloud-run-vs-k8s-compute-isolation.md` — companion (compute placement)
- `services/foundation/migrations/0007_control_plane_tables.sql` — `tenant_quota_usage` substrate
- `packages/audit-events/` — audit emission contract

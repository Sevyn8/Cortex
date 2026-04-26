# @cortex/blob-storage

Tenant-scoped GCS path generation and pre-signed URL helpers — wraps
`@google-cloud/storage` with tenant-prefix enforcement
(`tenants/{tenantId}/...`) and v4 signed URL generation with TTL caps.

This package is part of F01 Slice B. Per the slice scope decision (Q4),
Phase 1 ships a single shared bucket per env (`cortex-{env}-tenant-data`)
with object-key prefix isolation; bucket-per-tenant for ENTERPRISE
tier is deferred to F02.

## References

- `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md` — slice scope
- F01 build prompt §1.5 (blob storage requirements)
- Roadmap §10.7 (blob isolation IAM strategy — resolved by Slice B)
- Roadmap §10.8 (pre-signed URL signing identity)

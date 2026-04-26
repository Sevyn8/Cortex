# @cortex/encryption

Tenant-bound envelope-encryption helpers — wraps `@cortex/secrets`'s
KMS envelope primitives with tenant-id binding (AAD), audit emission
into the SHA-chained `audit_event` table, and a typed surface for
PII-class column writes/reads.

This package is part of F01 Slice B. Sub-phase 3 (this commit) ships
the scaffold + types + errors + zod schemas only — the
`encryptForTenant` / `decryptForTenant` runtime is sub-phase 4.

## References

- `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md` — slice scope
- `docs/architecture/decisions/ADR-INFRA-007-per-tenant-cmek-migration-path.md` — per-tenant CMEK migration path
- `packages/secrets/src/kms.ts` — underlying envelope primitive
- `packages/audit-events/` — audit emission contract

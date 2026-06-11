# Encryption + Blob Storage (F01 Slice B+)

> Relocated from CLAUDE.md for context-budget; loaded on demand.

PII encryption uses `@cortex/encryption` (envelope encryption with tenant-id AAD). Tenant-scoped blob storage uses `@cortex/blob-storage` (path-prefix isolation, pre-signed URLs).

The substrate: `tenant_kms_key` table per ADR-INFRA-007 - provisioned at tenant creation, currently points at the env's `cortex-general-key` (Phase 1); F02 swaps to real per-tenant keys without changing envelope format. AAD-bound envelopes (`utf8(tenantId)`) are the cryptographic isolation primitive - cross-tenant decrypt fails at the AEAD auth-tag regardless of which key the resolver returns.

GCS substrate: `cortex-{env}-tenant-data` bucket with bucket-level CMEK + `tenant-data-runtime` SA. Object-key isolation via `tenants/{tenantId}/{...}` prefix; cross-tenant escape protection at application layer (`@cortex/blob-storage` path validators - `buildFullObjectPath`, `assertObjectInTenantPrefix`). NEVER concatenate tenant prefixes manually.

**CRITICAL gotcha:** any new CMEK-encrypted GCS bucket needs the GCS PROJECT SERVICE AGENT IAM grant on the KMS key - `service-{project_number}@gs-project-accounts.iam.gserviceaccount.com` with `roles/cloudkms.cryptoKeyEncrypterDecrypter`. The runtime SA grant is for object-level I/O; the service-agent grant is for bucket-level CMEK encryption. Both required. Use `data "google_storage_project_service_account"` (not `google_project_service_identity` - the latter returns `.email = null` for already-materialized agents per ADR-INFRA-002 Quirk 1). Bucket's `depends_on` MUST include the GCS-agent grant. Worked example: `infra/terraform/modules/tenant-data-bucket/main.tf`.

When emitting from a new module, see `/docs/architecture/encryption-blob-storage-convention.md` for the full pattern. Recurring gotchas:

- Use verb `CREATE` for derivative artifacts (`PII_ENCRYPTED` is the canonical example) - the derivative is being created even if the underlying entity existed before.
- Service-actor in Phase 1 is hardcoded `'cortex-encryption'`; AC01 will swap to a request-scoped resolver (roadmap §4.14).
- `@cortex/encryption` warns at 64 KB envelope size; `@cortex/audit-events` warns at 64 KB canonicalized payload size - independent thresholds.
- Don't mix env-defaulted helpers (`generateSignedUrl`) with explicit-env helpers (`createSignedUrlSigner(env)`) in the same call path.
- For `expect(spy).toHaveBeenCalled*()` with `vi.fn()`: hoist the spy to a variable; using `expect(obj.method).toHaveBeenCalled()` trips `@typescript-eslint/unbound-method`.
- `gcloud storage buckets describe` returns `null` for several config fields - verify via `gsutil ls -L gs://...` or the storage v1 REST API.

References: ADR-INFRA-004 (env-level CMEK), ADR-INFRA-007 (per-tenant CMEK migration path), ADR-AU-001 (audit emission), planning doc `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md`, convention doc `docs/architecture/encryption-blob-storage-convention.md`.

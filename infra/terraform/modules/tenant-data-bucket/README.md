# tenant-data-bucket

Per-env GCS bucket for tenant blob storage. Provisions:

- A `cortex-{env}-tenant-data` bucket with CMEK, uniform bucket-level
  access, versioning, 30-day soft-delete, public-access prevention.
- A `tenant-data-runtime` service account.
- IAM bindings: SA → bucket (`roles/storage.objectAdmin`), SA → KMS key
  (`roles/cloudkms.cryptoKeyEncrypterDecrypter`).

## Slice B contract

Slice B ships shared-bucket-with-prefix isolation: every object key
MUST conform to `tenants/{tenantId}/{...path}`. Path enforcement is
the responsibility of `@cortex/blob-storage`'s path helpers
(`buildFullObjectPath`, `assertObjectInTenantPrefix`). Bucket-level
IAM is `objectAdmin` unscoped — cross-tenant escape protection is
application-layer.

## ENTERPRISE deferral

Per F01 Slice B planning Decision 4, bucket-per-tenant for
ENTERPRISE-tier tenants is deferred to F02. When that lands, this
module either:

- Stays as the STANDARD-tier bucket and a new module ships per-tenant
  buckets, or
- Accepts a `tier` variable that conditionally provisions per-tenant
  resources.

ADR-INFRA-007 captures the migration path; `tenant_kms_key`'s
`kms_key_resource_name` will route per-tenant key wrapping when F02
swaps the resolver.

## Inputs

| Variable         | Required | Default       | Description                                                                           |
| ---------------- | -------- | ------------- | ------------------------------------------------------------------------------------- |
| `project_id`     | yes      | —             | GCP project (`sevyn8-cortex-{env}`).                                                  |
| `environment`    | yes      | —             | `dev` / `staging` / `prod`. Validated.                                                |
| `region`         | no       | `asia-south1` | Bucket location. Per ADR-INFRA-003.                                                   |
| `gcs_kms_key_id` | yes      | —             | Fully-qualified `cortex-gcs-key` resource id from the env keyring.                    |
| `common_labels`  | no       | `{}`          | Labels merged with module-specific labels (`scope = "tenant-data"`, `env = "<env>"`). |

## Outputs

| Output                          | Description                                            |
| ------------------------------- | ------------------------------------------------------ |
| `bucket_name`                   | Name of the provisioned bucket.                        |
| `bucket_url`                    | `gs://` URL.                                           |
| `runtime_service_account_email` | Email of the runtime SA bound to the bucket + KMS key. |

## References

- F01 Slice B planning: `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md`
- ADR-INFRA-007: per-tenant CMEK migration path
- ADR-INFRA-004 §Decision 5: env-level CMEK posture
- `packages/blob-storage/src/path.ts` (the consumer side)

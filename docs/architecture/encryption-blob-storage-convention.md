# Encryption + Blob Storage Convention

Pattern reference for any module emitting PII through `@cortex/encryption`
or `@cortex/blob-storage`. Read before writing PII-handling or
tenant-scoped object code in a new module.

Companion documents: ADR-INFRA-007 (per-tenant CMEK migration path),
ADR-INFRA-004 (env-level CMEK posture), `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md`.

## When to encrypt

Two-category model — same partitioning as audit events:

- **PII / RESTRICTED / CONFIDENTIAL data** — encrypt at rest via
  `@cortex/encryption`. Examples: government IDs (SSN, PAN, Aadhaar),
  biometrics (skin scans, retina prints), payment card data, contact
  details (email, phone), location traces, retail loss-prevention
  frames, health records.

- **Non-PII operational state** — store as-is. Examples: tenant_id,
  external_id, timestamps, audit metadata, configuration values, public
  branding assets, monotonic counters.

When unsure: classify against the data-classification policy
(`docs/data-classification.md` if it exists; otherwise the spec text in
F01 §1.2.4). When in doubt: encrypt.

## How to encrypt — the canonical pattern

```typescript
import { encryptForTenant, decryptForTenant } from '@cortex/encryption';
import { bindTenantToDbSession } from '@cortex/tenant-context';

await db.transaction(async (tx) => {
  await bindTenantToDbSession(tx, tenantId);

  // Encrypt
  const payload = await encryptForTenant(tx, {
    tenantId,
    plaintext: 'sensitive PII string',
  });
  // payload: { envelope: Buffer, keyResourceName, tenantId, aad }
  // Persist `payload.envelope` to your bytea column, plus the forensic
  // metadata (keyResourceName, aad) if your access pattern needs it.

  // Decrypt
  const recovered = await decryptForTenant(tx, { tenantId, payload });
  // recovered: Buffer (caller decides string vs bytes interpretation)
});
```

Caller contract:

- MUST be inside `db.transaction(...)`.
- MUST call `bindTenantToDbSession(tx, tenantId)` BEFORE encrypt /
  decrypt — RLS on the `audit_event` write requires it.
- MUST NOT supply `occurred_at` on the audit event (library auto-stamps
  `clock_timestamp()` per planning-doc Decision 11).
- Strings are UTF-8 encoded after NFC normalization. Buffers pass
  through verbatim (caller owns canonicalization for binary).

## Cross-tenant isolation

AAD-bound envelopes are the cryptographic isolation primitive.
`envelope.encrypt(tenantId, plaintext)` sets AAD = `utf8(tenantId)`;
`envelope.decrypt(tenantId, ciphertext)` recomputes AAD from the
supplied tenantId. Mismatch → AEAD auth-tag verification fails →
`EncryptionExecutionError` with cause-name `EnvelopeDecryptError`.

Defense-in-depth: `decryptForTenant` also explicitly checks
`params.tenantId === params.payload.tenantId` and rejects with
`EncryptionValidationError` before any KMS call. The cryptographic
check would catch mismatches anyway, but the explicit check produces a
clearer error message and saves a KMS unwrap call.

Tests must exercise both paths (covered in
`packages/encryption/test/encrypt.spec.ts`).

## When to use blob storage

Tenant-scoped objects: documents, images, exports, model artifacts,
training datasets. Scope to `tenants/{tenantId}/...` always — NEVER
construct paths manually.

Cross-tenant escape protection is application-layer (path validators),
NOT bucket-IAM. The `tenant-data-runtime` SA has `objectAdmin` on the
bucket; the prefix discipline lives in `@cortex/blob-storage`.

```typescript
import { buildFullObjectPath, generateSignedUrl } from '@cortex/blob-storage';

// Construct a path
const fullPath = buildFullObjectPath(tenantId, 'reports/2026/04/sales.csv');
// → 'tenants/{tenantId}/reports/2026/04/sales.csv'

// Generate a signed URL
const result = await generateSignedUrl({
  tenantId,
  objectName: 'reports/2026/04/sales.csv',
  expiresInSeconds: 900, // 15 min
  action: 'read',
});
// result: { url, expiresAt, fullObjectPath }
```

Anti-patterns to reject in code review:

- `\`tenants/${tenantId}/${name}\`` template-string path construction
- `bucket.file('tenants/foo/...')` without going through
  `buildFullObjectPath`
- `objectName` starting with `tenants/` (rejected at the schema)
- TTLs above 7 days (rejected at the schema; rotate the URL instead)

## Pre-signed URLs

Phase 1 conventions:

- TTL cap: 7 days. Schema rejects above. Default 15 min for read; 60
  sec for write. Caller picks the value.
- v4 signing only (`getSignedUrl({ version: 'v4', ... })`).
- `action: 'read' | 'write'` — `delete` and `resumable` not exposed.
- Write actions SHOULD include `contentType` (binds the client to it
  at upload time).
- Signing identity: `tenant-data-runtime@sevyn8-cortex-{env}.iam.gserviceaccount.com`.
  The signing operation uses the SA's RSA private key (separate
  concern from bucket-level CMEK; CMEK protects bytes at rest, signing
  authorizes URL access).

Slice B does NOT emit audit events on signed-URL issuance — the
convention is: callers wrapping this in a higher-level "issue download
URL for resource X" flow handle their own audit emission. Revisit if a
downstream consumer surfaces a need.

## CRITICAL: GCS bucket CMEK service-agent grant

When provisioning a CMEK-encrypted GCS bucket, the GCS PROJECT SERVICE
AGENT (NOT the runtime SA) needs
`roles/cloudkms.cryptoKeyEncrypterDecrypter` on the KMS key. Without
this grant, bucket creation fails at `terraform apply` with HTTP 403:
`"Permission denied on Cloud KMS key. Please ensure that your Cloud
Storage service account has been authorized to use this key."`

Bucket-level CMEK is performed by GCS internally using its service
agent identity (`service-{project_number}@gs-project-accounts.iam.gserviceaccount.com`).
The runtime SA grant is for object-level I/O. Both are required.

The pattern:

```hcl
data "google_storage_project_service_account" "gcs" {
  project = var.project_id
}

resource "google_kms_crypto_key_iam_member" "gcs_agent_cmek" {
  crypto_key_id = var.gcs_kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_storage_bucket" "your_bucket" {
  encryption {
    default_kms_key_name = var.gcs_kms_key_id
  }
  depends_on = [google_kms_crypto_key_iam_member.gcs_agent_cmek]
}
```

The bucket's `depends_on` MUST include the GCS-agent grant — without
explicit ordering, Terraform may try to create the bucket before the
grant lands.

References: CLAUDE.md "IAM gotchas" Quirk 5, ADR-INFRA-002 Quirk 1,
`infra/terraform/bootstrap/main.tf` (tfstate bucket precedent),
`infra/terraform/modules/tenant-data-bucket/main.tf` (Slice B pattern).

## Audit emission for encryption operations

The library emits two action types:

- `PII_ENCRYPTED` — verb `CREATE`, `after_state` carries forensic
  metadata `{ tenant_id, key_resource_name, payload_byte_size }`. The
  encrypted payload is being CREATED, even if the underlying entity
  existed before encryption.
- `PII_DECRYPTED` — verb `READ`, no state. Sensitive read; per F01
  §1.2.4 every decrypt is audited.

Service actor in Phase 1: `actorType='service'`, `actorId='cortex-encryption'`.
The encryption library doesn't know which user triggered the
operation; the higher-level audit (e.g., `TENANT_UPDATED` from a
request handler) carries the user-attributed actor. AC01 will
introduce a request-scoped actor resolver via async-local context;
roadmap §4.14 tracks the swap.

## Verb-CREATE for derivative artifacts

ADR-AU-001 Decision 3 maps verbs to before/after-state requirements:

| Verb    | Requires `before_state` | Requires `after_state` |
| ------- | ----------------------- | ---------------------- |
| CREATE  | forbidden               | required               |
| READ    | forbidden               | forbidden              |
| UPDATE  | required                | required               |
| DELETE  | required                | forbidden              |
| APPROVE | optional                | optional               |
| REJECT  | optional                | optional               |
| EXECUTE | optional                | optional               |

For derivative artifacts (encrypted payloads, hashes, snapshots,
exports), use `CREATE` — the _derivative_ is being created, even if
the underlying entity already existed. `PII_ENCRYPTED` is the
canonical example: an envelope is created from a plaintext that
already existed.

When the derivative is updated in place rather than recreated, prefer
`UPDATE` (e.g., a re-encryption with a rotated key would be `UPDATE`
of the existing envelope record, not `CREATE` of a new one).

## Operational vs compliance — quick reference

| Signal                       | Channel                           | Audience                          |
| ---------------------------- | --------------------------------- | --------------------------------- |
| `[SECRETS-AUDIT]` operations | pino → Cloud Logging              | SRE / on-call / debugging         |
| `getKeyForTenant` lookups    | pino → Cloud Logging              | Operational only                  |
| `PII_ENCRYPTED` events       | `audit_event` table (SHA-chained) | Regulators / auditors / forensics |
| `PII_DECRYPTED` events       | `audit_event` table (SHA-chained) | Regulators / auditors / forensics |
| Soft-size WARN (>64 KB)      | pino → Cloud Logging              | SRE — tune-knob signal            |

Test runs produce significant operational pino-log volume (every
`getKeyForTenant` call + every `envelope.encrypt`/`decrypt` emits a
`[SECRETS-AUDIT]` line). This is expected and routes to stdout, not to
`audit_event`. They serve different audiences.

In tests with custom `LogCapture` loggers, `await capture.flush()`
before assertions — pino's destination is async; without flush, the
captured records aren't yet written.

## Soft-size threshold semantics

`@cortex/encryption` warns at 64 KB **envelope size**. `@cortex/audit-events`
warns at 64 KB **canonicalized payload size**. They are independent
thresholds for different concerns:

- Encryption envelope > 64 KB ≈ plaintext > 64 KB → callers
  encrypting large blobs should consider chunking or a separate
  large-blob storage path.
- Audit payload > 64 KB → caller is recording an oversized
  `before_state` / `after_state` snapshot; pre-summarization
  recommended.

Both thresholds are heuristic; revisit when observed distribution
surfaces a pattern (roadmap §1.9).

## Module-load cycle awareness

When importing `@cortex/audit-events` from a new package:

- Use type-only imports for `@cortex/observability` where possible.
- Resolve `createLogger` via dynamic `await import('@cortex/observability')`
  on first WARN emission. See `packages/audit-events/src/emit.ts` for
  the canonical pattern.
- Don't eagerly import `@cortex/observability` at module-load level —
  closes the cycle through `observability → tenant-context`.
- If your module is consumed by `@cortex/tenant-context` (directly or
  transitively), this matters even more — every new edge expands the
  cycle topology. Roadmap §4.13 captures the architectural fix.

`@cortex/tenant-context/src/tenants.ts:create()` is a worked example:
`@cortex/secrets`'s `buildKeyResourceName` is loaded via dynamic
import to break the cycle.

## Common pitfalls

- Don't construct GCS object paths manually — `buildFullObjectPath`
  is the only correct constructor.
- Don't mix env-defaulted helpers (`generateSignedUrl`) with
  explicit-env helpers (`createSignedUrlSigner(env)`) in the same call
  path — pick one mode per call site.
- For `expect(spy).toHaveBeenCalled*()` with `vi.fn()`: hoist the spy
  to a variable, use the spy directly in the assertion. Lint rule
  `@typescript-eslint/unbound-method` flags `expect(obj.method).toHaveBeenCalled()`.
- Don't pass `tenantId` as a Buffer — it's typed `string` in
  `EncryptParams`; AAD encoding happens inside the library.
- Don't supply `occurred_at` to audit emission — library auto-stamps
  `clock_timestamp()`. Same applies for any audit event from any
  module.
- Don't expect operational pino logs to land in `audit_event` — they
  are separate channels.

## Operational verification

`gcloud storage buckets describe` returns `null` for several fields
(uniform-bucket-level-access, soft-delete config, encryption defaults).
For verification, prefer:

- `gsutil ls -L gs://bucket-name` — shows full bucket configuration.
- Storage v1 REST API:
  ```bash
  curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    "https://storage.googleapis.com/storage/v1/b/{bucket-name}"
  ```
- Terraform's idempotent re-plan (`terraform plan` returning "No
  changes") — the canonical post-apply verification per CLAUDE.md
  Terraform workflow.

## Terraform apply pattern

Per CLAUDE.md "Terraform workflow":

1. `terraform plan -out=plan.tfplan` (write the plan to a file).
2. Review the diff.
3. `terraform apply plan.tfplan` (apply the saved plan; no prompt).
4. `terraform plan` (re-plan to verify idempotency — should report
   "No changes").

The `make tf-apply-{env}` target runs interactive `terraform apply`
without a plan file — works for human-driven applies but breaks in
non-interactive shells (Cloud Build, scripted operations). The
plan-file pattern above is the canonical apply path for both
interactive and scripted workflows.

When the make target prompts for `Enter a value:` and you'd rather use
the plan-file flow, run `terraform plan -out=…` directly with
`GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` set, then `terraform apply
<planfile>`. Same SA, same backend, no prompt.

## References

- ADR-INFRA-007 — Per-tenant CMEK migration path
- ADR-INFRA-004 — CMEK key hierarchy (env-level keys)
- ADR-AU-001 — Audit-events library (encrypt/decrypt emit through this)
- F01 build prompt §1.2.4 (encryption), §1.5 (blob storage)
- `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md` — slice scope
- `docs/architecture/audit-event-convention.md` — companion (audit emission)
- `packages/encryption/src/` — encrypt/decrypt + types + schemas
- `packages/blob-storage/src/` — path helpers + signing
- `infra/terraform/modules/tenant-data-bucket/` — provisioning module
- Roadmap §4.13 (observability ↔ tenant-context decoupling), §4.14 (AC01 actor swap), §4.15 (resolver-call deduplication)

# @cortex/secrets

Runtime library for Secret Manager access and envelope encryption of PII. Phase 1
surface per P0.7 build prompt and ADR-INFRA-004.

## Quick start

```ts
import { secrets, envelope, getKeyForTenant } from '@cortex/secrets';

// Fetch a secret by its FULL name (cortex-<category>-<specific-name>).
// Short names are not supported — the regex is enforced.
const apiKey = await secrets.get('cortex-email-sendgrid-api-key');

// Envelope-encrypt PII, binding the ciphertext to a tenant (AAD).
const ciphertext = await envelope.encrypt(tenantId, 'user@example.com');
const plaintext = await envelope.decrypt(tenantId, ciphertext);

// Resolve the KMS key resource for a tenant.
// Phase 1 stub: returns env's cortex-general-key regardless of tenantId.
const keyName = getKeyForTenant(tenantId);
```

## Environment variables

| Name                  | Required | Default          | Purpose                            |
| --------------------- | -------- | ---------------- | ---------------------------------- |
| `GCP_PROJECT_ID`      | yes      | —                | Project hosting secrets + KMS keys |
| `CORTEX_KMS_LOCATION` | no       | `asia-south1`    | KMS key location                   |
| `CORTEX_KMS_KEYRING`  | no       | `cortex-keyring` | KMS keyring name                   |
| `CORTEX_ACTOR`        | no       | `unknown`        | Best-effort audit `actor` field    |

Auth: Application Default Credentials (ADC). In GCP workloads the pod/service SA
provides identity automatically. Locally, run
`gcloud auth application-default login` once per session.

## API

### `secrets.get(secretId, options?)`

Fetch the latest version of a secret and return its UTF-8 decoded payload.
Binary payloads are not supported in Phase 1 — `secrets.getBytes` is deferred
until a binary consumer appears.

- **secretId** — full name matching `^cortex-(auth|ai|email|db|webhook|integration|tenant-<id>|app)-<name>$`. Regex is identical to `infra/terraform/modules/secret/`.
- **options.tenantId** — optional UUID for audit context; does NOT scope access (IAM does).

Throws: `SecretsValidationError`, `SecretNotFoundError`, `PermissionDeniedError`, `KmsUnavailableError`.

### `secrets.put(secretId, payload, options?)`

Add a new version to an existing secret. The secret metadata MUST already exist
(Terraform-owned via `infra/terraform/modules/secret/`); this function only
creates versions.

- **payload** — UTF-8 string
- Returns `{ name, versionId }` where `name` is the fully-qualified version resource name.

Throws: `SecretsValidationError`, `SecretNotFoundError`, `PermissionDeniedError`, `KmsUnavailableError`.

### `envelope.encrypt(tenantId, plaintext)`

Envelope-encrypt with `cortex-general-key` as the KEK. Per-operation 32-byte DEK
(random), AES-256-GCM with `tenantId` as AAD. See [Wire format](#wire-format).

- **plaintext** — `Buffer | string` (strings are UTF-8 encoded)
- Returns the packed `Buffer` in the wire format below.

Throws: `SecretsValidationError`, `EnvelopeEncryptError`, `KmsUnavailableError`.

### `envelope.decrypt(tenantId, ciphertext)`

Reverse of `envelope.encrypt`. `tenantId` MUST match the encrypt-time value or
the AEAD tag check fails — this is the cross-tenant misuse guard.

Throws: `SecretsValidationError` (malformed wire format / version mismatch),
`EnvelopeDecryptError` (auth tag failure / KMS unwrap failure), `KmsUnavailableError`.

### `getKeyForTenant(tenantId)`

Returns the fully-qualified KMS key resource name for a tenant.

**Phase 1 stub:** ignores `tenantId`, returns env's `cortex-general-key`. Per
ADR-INFRA-004 Decision 5, per-tenant keys are deferred to Phase 2+; F02 will
swap this implementation to consult the `tenant_kms_key` control-plane table.

Throws: `SecretsValidationError` (non-UUID tenantId), `ConfigError` (missing
`GCP_PROJECT_ID`).

## Wire format

```
  0       1        3              3+L        15+L        31+L       N
  ┌───────┼────────┼──────────────┼──────────┼───────────┼──────────┐
  │ ver=1 │ dek_len │ wrapped_DEK  │   IV     │ auth_tag  │ cipher    │
  │  (1)  │  (u16)  │     (L)      │   (12)   │   (16)    │   (M)     │
  └───────┴────────┴──────────────┴──────────┴───────────┴──────────┘

version:       0x01 (uint8, wire-format marker)
wrap_len:      uint16 big-endian (GCP KMS wrap output is variable-length)
wrapped_DEK:   GCP-KMS-encrypted DEK (cortex-general-key)
IV:            12 bytes, random per operation
auth_tag:      16 bytes (AES-256-GCM tag)
ciphertext:    same length as plaintext

AEAD:          AES-256-GCM
DEK:           32 bytes, crypto.randomBytes per operation (no reuse)
AAD:           utf8(tenantId) — cross-tenant decrypt fails at tag verification
```

Typical overhead: ~201 bytes per encrypted value. The version byte allows
future wire-format evolution without ambiguity.

## Audit logging

Every call emits a JSON line to stderr with the `[SECRETS-AUDIT]` prefix:

```json
[SECRETS-AUDIT] {"operation":"get","tenant_id":"22222222-...","secret_id":"cortex-email-sendgrid","key_id":null,"outcome":"ok","error_code":null,"duration_ms":42,"actor":"unknown"}
```

Fields:

- `operation` — `get` | `put` | `encrypt` | `decrypt` | `getKeyForTenant`
- `tenant_id` — UUID or `null` if not supplied
- `secret_id` — full secret name (get/put) or `null`
- `key_id` — fully-qualified KMS key resource name (encrypt/decrypt/getKeyForTenant) or `null`
- `outcome` — `ok` | `error`
- `error_code` — error class code (e.g. `NOT_FOUND`, `VALIDATION`) or `null`
- `duration_ms` — integer
- `actor` — `$CORTEX_ACTOR` or `unknown`

**TODO (P0.6 Phase 2):** swap stderr emission for `@cortex/observability`
structured logger. Grep marker: `[SECRETS-AUDIT]` (also in `src/audit.ts`).

## Errors

All errors extend `SecretsError`:

| Class                    | `code`                    | Typical cause                                                   |
| ------------------------ | ------------------------- | --------------------------------------------------------------- |
| `SecretsValidationError` | `VALIDATION`              | zod input check failed                                          |
| `ConfigError`            | `CONFIG`                  | `GCP_PROJECT_ID` unset                                          |
| `SecretNotFoundError`    | `NOT_FOUND`               | Secret metadata doesn't exist (Terraform must create first)     |
| `PermissionDeniedError`  | `PERMISSION_DENIED`       | Caller SA lacks `secretAccessor` / `secretVersionAdder`         |
| `EnvelopeEncryptError`   | `ENVELOPE_ENCRYPT_FAILED` | KMS wrap failure or local crypto failure                        |
| `EnvelopeDecryptError`   | `ENVELOPE_DECRYPT_FAILED` | AEAD tag mismatch (tampered/wrong tenant) or KMS unwrap failure |
| `KmsUnavailableError`    | `KMS_UNAVAILABLE`         | Transient GCP failure (caller may retry)                        |

GCP client library handles retries internally; `KmsUnavailableError` surfaces
only after its retries are exhausted.

## Known Phase-1 stubs

- `getKeyForTenant(tenantId)` ignores `tenantId`, returns env's `cortex-general-key` (per ADR-INFRA-004 Decision 5)
- No rotation (F02 scope)
- Audit goes to stderr (pre-`@cortex/observability`)
- UTF-8-only `get` / `put` — binary payload support deferred until first consumer

## Operational notes

- Secret metadata ownership stays with Terraform (`infra/terraform/modules/secret/`). Library only creates versions.
- `cortex-observer` SA has zero `secretmanager.*` permissions by role design — tests must not run as it.
- Per-tenant CMEK is deferred to Phase 2+ per ADR-INFRA-004. The `getKeyForTenant` interface is swap-ready for F02.
- Envelope uses `cortex-general-key`, NOT `cortex-secrets-key` (which is exclusive to Secret Manager's own CMEK at the GCP layer).

## Integration tests

Unit tests run by default. Integration tests against dev GCP are gated by
`CORTEX_INTEGRATION_TESTS=true`:

```
cd packages/secrets
gcloud auth application-default login   # once per session
GCP_PROJECT_ID=sevyn8-cortex-dev CORTEX_INTEGRATION_TESTS=true pnpm test:integration
```

**What they exercise:**

- `test/integration/secret-manager.integration.spec.ts` — reads the existing
  `cortex-db-postgres-break-glass-dev` secret. Read-only.
- `test/integration/envelope.integration.spec.ts` — round-trips against dev's
  `cortex-general-key`; verifies cross-tenant AAD failure and tamper detection.

**Deferred:** `secrets.put` integration testing deferred until F02 exercises it
(per P0.7 design lock).

## References

- [P0.7 build prompt](../../docs/build-prompts/cortex_build_prompts_v3.md) — §P0.7 at line 624
- [ADR-INFRA-004](../../docs/architecture/decisions/ADR-INFRA-004-cmek-key-hierarchy.md) — CMEK key hierarchy, per-tenant deferral rationale
- [CLAUDE.md](../../CLAUDE.md) — §Secret Manager naming (regex authoritative here + in Terraform module)
- [`infra/terraform/modules/secret/`](../../infra/terraform/modules/secret/) — Terraform-owned secret metadata creation

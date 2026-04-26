/**
 * Public types for `@cortex/encryption`.
 *
 * The package wraps `@cortex/secrets`'s envelope-encryption primitives
 * (KMS wrap of a per-message DEK, AES-256-GCM AEAD over plaintext,
 * AAD = utf8(tenantId)) with a tenant-bound surface and audit emission.
 *
 * `EncryptedPayload` is the canonical output shape exposed by
 * `encryptForTenant`. Callers persist it (in DB columns or rows),
 * forward it across system boundaries, or pass it back to
 * `decryptForTenant` for retrieval.
 *
 * The `keyResourceName`, `tenantId`, and `aad` fields are NOT secret —
 * they are forensic / audit metadata. They MAY safely accompany the
 * ciphertext at rest.
 */

/**
 * Canonical encrypted-payload output from `encryptForTenant`.
 *
 * `envelope` is the opaque output of `@cortex/secrets.envelope.encrypt`,
 * which is a self-contained AEAD-protected blob containing the version
 * byte, KMS-wrapped DEK, IV, auth tag, and ciphertext. This package
 * intentionally treats the envelope as a single opaque buffer rather
 * than splitting components — the secrets package owns the wire format,
 * and consumers pass the envelope back unchanged to `decryptForTenant`.
 *
 * The non-envelope fields (`tenantId`, `keyResourceName`, `aad`) are
 * forensic metadata: they let consumers verify what AAD was used at
 * encrypt time, which KMS key wrapped the DEK (matters for rotation
 * forensics), and which tenant the payload was bound to. None are
 * cryptographically required at decrypt time — `decryptForTenant`
 * recomputes AAD from the supplied tenantId and the secrets envelope
 * carries the wrapped DEK reference internally — but they're surfaced
 * for audit verifiability and operational visibility.
 *
 * Format-version evolution: if `@cortex/secrets` ever rotates the
 * envelope format (algorithm change, header field addition), the
 * version byte at envelope[0] routes the decrypt path; consumers see
 * no API change. ENCRYPTION_PAYLOAD_VERSION here describes the shape
 * of THIS interface (the EncryptedPayload object), not the inner
 * cryptographic envelope.
 */
export interface EncryptedPayload {
  /** Opaque AEAD envelope from @cortex/secrets — pass unchanged to decryptForTenant. */
  readonly envelope: Buffer;

  /** Fully-qualified Cloud KMS resource name of the KEK that wrapped the DEK. */
  readonly keyResourceName: string;

  /** Tenant id this payload was encrypted for (audit / forensic provenance). */
  readonly tenantId: string;

  /** Explicit AAD bytes used at encrypt time (= utf8(tenantId)). */
  readonly aad: Buffer;
}

/**
 * Caller input to `encryptForTenant`. Strings are UTF-8 + NFC-normalized
 * before being handed to the AEAD layer (matches the audit-events
 * NFC-on-payload convention for cross-package consistency).
 */
export interface EncryptParams {
  /** Tenant id (UUID). Becomes AAD; mismatch on decrypt fails. */
  tenantId: string;

  /**
   * The plaintext to encrypt. `Buffer` is consumed verbatim; `string`
   * is UTF-8 encoded after NFC normalization.
   */
  plaintext: Buffer | string;
}

/**
 * Caller input to `decryptForTenant`. The `tenantId` MUST match the
 * value supplied at encrypt time or the AEAD auth-tag verification
 * fails (raised as `EncryptionExecutionError`).
 */
export interface DecryptParams {
  /** Tenant id (UUID). MUST match the encrypt-time tenantId. */
  tenantId: string;

  /** The payload produced by a prior `encryptForTenant` call. */
  payload: EncryptedPayload;
}

/**
 * Format version sentinel for `EncryptedPayload`. Pinned at 1 today;
 * future format evolutions (additional metadata fields, new AEAD
 * algorithm, etc.) will increment this and may produce migration
 * shapes. The wire-format-version byte INSIDE the underlying
 * `@cortex/secrets` envelope is independent of this constant —
 * `ENCRYPTION_PAYLOAD_VERSION` describes this package's struct shape;
 * the secrets envelope's `ver(1)` byte describes the byte layout
 * within `ciphertext + iv + wrappedKey`.
 */
export const ENCRYPTION_PAYLOAD_VERSION = 1 as const;

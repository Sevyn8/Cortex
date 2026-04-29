import { KeyManagementServiceClient } from '@google-cloud/kms';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { auditLog } from './audit.js';
import {
  SecretsError,
  SecretsValidationError,
  EnvelopeEncryptError,
  EnvelopeDecryptError,
  KmsUnavailableError,
} from './errors.js';

// Wire format:
//   [ver(1)] [wrap_len(u16 BE)] [wrapped_DEK] [IV(12)] [tag(16)] [ciphertext]
// AEAD: AES-256-GCM. AAD: utf8(tenantId) — ciphertext fails to decrypt for
// a different tenantId (cross-tenant misuse protection).
const FORMAT_VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEK_LENGTH = 32;
const WRAP_LEN_OFFSET = 1;
const WRAP_DATA_OFFSET = 3;

const tenantIdSchema = z.string().uuid();

// F02 Slice D D.2 widens the KmsClient surface to include the rotation
// primitives (createCryptoKeyVersion + updateCryptoKeyPrimaryVersion +
// destroyCryptoKeyVersion). encrypt/decrypt remain the only methods
// callers in the encryption hot path use; rotation is operator-driven
// via tenants.rotateKeys.
type KmsClient = Pick<
  KeyManagementServiceClient,
  | 'encrypt'
  | 'decrypt'
  | 'createCryptoKeyVersion'
  | 'updateCryptoKeyPrimaryVersion'
  | 'destroyCryptoKeyVersion'
  | 'getCryptoKey'
>;
type KmsClientFactory = () => KmsClient;

let clientFactory: KmsClientFactory = () => new KeyManagementServiceClient() as KmsClient;
let clientSingleton: KmsClient | undefined;

function getClient(): KmsClient {
  clientSingleton ??= clientFactory();
  return clientSingleton;
}

/** Test-only: override the KMS client factory. Resets the memoized singleton. */
export function __setClientFactoryForTesting(factory: KmsClientFactory | null): void {
  if (factory === null) {
    clientFactory = () => new KeyManagementServiceClient() as KmsClient;
  } else {
    clientFactory = factory;
  }
  clientSingleton = undefined;
}

function mapGcpError(err: unknown, operation: 'encrypt' | 'decrypt'): SecretsError {
  const e = err as { code?: number | string; message?: string } | undefined;
  const message = e?.message ?? `KMS ${operation} error`;
  if (e?.code === 7 || e?.code === 'PERMISSION_DENIED' || e?.code === 403) {
    const Cls = operation === 'encrypt' ? EnvelopeEncryptError : EnvelopeDecryptError;
    return new Cls(`KMS ${operation} denied: ${message}`, {
      cause: err as Error,
    });
  }
  return new KmsUnavailableError(message, { cause: err as Error });
}

/**
 * Envelope-encrypt plaintext using a caller-supplied KMS key resource
 * name as the KEK.
 *
 * Wire format (big-endian): [ver(1)] [wrap_len(u16)] [wrapped_DEK(L)]
 *                           [IV(12)] [auth_tag(16)] [ciphertext(N)]
 *
 * AEAD: AES-256-GCM. AAD: utf8(tenantId) — binds ciphertext to tenant context.
 *
 * Per planning-doc §4.15 cleanup vector (sub-phase 6.1, 2026-04-27):
 * `keyResourceName` is now a required parameter rather than being
 * derived internally via `buildKeyResourceName('cortex-general-key')`.
 * Callers resolve once via `getKeyForTenant(db, tenantId)` and thread
 * the result through to both this function and any audit-row recording.
 * This eliminates the dual-lookup that latently broke once
 * `getKeyForTenant` started returning real per-tenant keys (the
 * audit-recorded key would have differed from the actual KEK).
 *
 * @param tenantId UUID; used as AAD
 * @param plaintext Buffer or UTF-8 string
 * @param keyResourceName fully-qualified KMS key resource name (caller-resolved)
 * @throws SecretsValidationError invalid tenantId
 * @throws EnvelopeEncryptError   KMS wrap failure or local crypto failure
 * @throws KmsUnavailableError    transient GCP failure
 */
async function encryptEnvelope(
  tenantId: string,
  plaintext: Buffer | string,
  keyResourceName: string,
): Promise<Buffer> {
  const start = Date.now();
  const keyName = keyResourceName;

  const tenantParsed = tenantIdSchema.safeParse(tenantId);
  if (!tenantParsed.success) {
    auditLog({
      operation: 'encrypt',
      tenant_id: null,
      secret_id: null,
      key_id: null,
      outcome: 'error',
      error_code: 'VALIDATION',
      duration_ms: Date.now() - start,
    });
    throw new SecretsValidationError(`invalid tenantId: ${tenantParsed.error.message}`);
  }

  const plaintextBuf = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const aad = Buffer.from(tenantParsed.data, 'utf8');

  try {
    const dek = crypto.randomBytes(DEK_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(aad);
    const ct1 = cipher.update(plaintextBuf);
    const ct2 = cipher.final();
    const ciphertext = Buffer.concat([ct1, ct2]);
    const tag = cipher.getAuthTag();

    const [resp] = await getClient().encrypt({ name: keyName, plaintext: dek });
    const wrappedDek = resp?.ciphertext;
    if (
      wrappedDek === null ||
      wrappedDek === undefined ||
      typeof wrappedDek === 'string' ||
      wrappedDek.length === 0
    ) {
      throw new EnvelopeEncryptError('KMS returned empty or invalid wrapped DEK');
    }
    const wrappedDekBuf = Buffer.from(wrappedDek);
    const wrapLen = wrappedDekBuf.length;
    if (wrapLen > 0xffff) {
      throw new EnvelopeEncryptError(`wrapped DEK length ${wrapLen} exceeds u16 max`);
    }

    const out = Buffer.alloc(1 + 2 + wrapLen + IV_LENGTH + TAG_LENGTH + ciphertext.length);
    let off = 0;
    out.writeUInt8(FORMAT_VERSION, off);
    off += 1;
    out.writeUInt16BE(wrapLen, off);
    off += 2;
    wrappedDekBuf.copy(out, off);
    off += wrapLen;
    iv.copy(out, off);
    off += IV_LENGTH;
    tag.copy(out, off);
    off += TAG_LENGTH;
    ciphertext.copy(out, off);

    auditLog({
      operation: 'encrypt',
      tenant_id: tenantParsed.data,
      secret_id: null,
      key_id: keyName,
      outcome: 'ok',
      error_code: null,
      duration_ms: Date.now() - start,
    });
    return out;
  } catch (err) {
    const mapped = err instanceof SecretsError ? err : mapGcpError(err, 'encrypt');
    auditLog({
      operation: 'encrypt',
      tenant_id: tenantParsed.data,
      secret_id: null,
      key_id: keyName,
      outcome: 'error',
      error_code: mapped.code,
      duration_ms: Date.now() - start,
    });
    throw mapped;
  }
}

/**
 * Reverse of `encryptEnvelope`. `tenantId` MUST match the encrypt-time value
 * or the AAD check fails and throws EnvelopeDecryptError.
 *
 * Per planning-doc §4.15 (sub-phase 6.1): `keyResourceName` is now a
 * required parameter. Callers thread the value recorded in the
 * `EncryptedPayload.keyResourceName` field at encrypt time, ensuring
 * decrypt uses the same KEK that encrypt used.
 *
 * @param tenantId UUID; must match AAD used at encrypt
 * @param ciphertext Buffer in the wire format produced by encryptEnvelope
 * @param keyResourceName fully-qualified KMS key resource name (the
 *   value recorded by the caller at encrypt time)
 * @throws SecretsValidationError malformed wire format, version mismatch, or invalid tenantId
 * @throws EnvelopeDecryptError   auth-tag failure (tampered / wrong tenant) or KMS unwrap failure
 * @throws KmsUnavailableError    transient GCP failure
 */
async function decryptEnvelope(
  tenantId: string,
  ciphertext: Buffer,
  keyResourceName: string,
): Promise<Buffer> {
  const start = Date.now();
  const keyName = keyResourceName;

  const tenantParsed = tenantIdSchema.safeParse(tenantId);
  if (!tenantParsed.success) {
    auditLog({
      operation: 'decrypt',
      tenant_id: null,
      secret_id: null,
      key_id: null,
      outcome: 'error',
      error_code: 'VALIDATION',
      duration_ms: Date.now() - start,
    });
    throw new SecretsValidationError(`invalid tenantId: ${tenantParsed.error.message}`);
  }

  const aad = Buffer.from(tenantParsed.data, 'utf8');

  try {
    if (ciphertext.length < 1 + 2 + 1 + IV_LENGTH + TAG_LENGTH) {
      throw new SecretsValidationError(`ciphertext too short: ${ciphertext.length} bytes`);
    }
    const version = ciphertext.readUInt8(0);
    if (version !== FORMAT_VERSION) {
      throw new SecretsValidationError(`unsupported envelope version: 0x${version.toString(16)}`);
    }
    const wrapLen = ciphertext.readUInt16BE(WRAP_LEN_OFFSET);
    const expectedMin = WRAP_DATA_OFFSET + wrapLen + IV_LENGTH + TAG_LENGTH;
    if (ciphertext.length < expectedMin) {
      throw new SecretsValidationError(
        `ciphertext truncated: expected at least ${expectedMin} bytes, got ${ciphertext.length}`,
      );
    }

    let off = WRAP_DATA_OFFSET;
    const wrappedDek = ciphertext.subarray(off, off + wrapLen);
    off += wrapLen;
    const iv = ciphertext.subarray(off, off + IV_LENGTH);
    off += IV_LENGTH;
    const tag = ciphertext.subarray(off, off + TAG_LENGTH);
    off += TAG_LENGTH;
    const ct = ciphertext.subarray(off);

    let dek: Buffer;
    try {
      const [resp] = await getClient().decrypt({
        name: keyName,
        ciphertext: wrappedDek,
      });
      const dekBytes = resp?.plaintext;
      if (
        dekBytes === null ||
        dekBytes === undefined ||
        typeof dekBytes === 'string' ||
        dekBytes.length !== DEK_LENGTH
      ) {
        throw new EnvelopeDecryptError('KMS returned invalid unwrapped DEK');
      }
      dek = Buffer.from(dekBytes);
    } catch (err) {
      if (err instanceof SecretsError) throw err;
      throw mapGcpError(err, 'decrypt');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    let pt: Buffer;
    try {
      const pt1 = decipher.update(ct);
      const pt2 = decipher.final();
      pt = Buffer.concat([pt1, pt2]);
    } catch (err) {
      throw new EnvelopeDecryptError(
        'envelope decrypt failed: authentication tag mismatch (ciphertext tampered or tenantId mismatch)',
        { cause: err as Error },
      );
    }

    auditLog({
      operation: 'decrypt',
      tenant_id: tenantParsed.data,
      secret_id: null,
      key_id: keyName,
      outcome: 'ok',
      error_code: null,
      duration_ms: Date.now() - start,
    });
    return pt;
  } catch (err) {
    const mapped = err instanceof SecretsError ? err : mapGcpError(err, 'decrypt');
    auditLog({
      operation: 'decrypt',
      tenant_id: tenantParsed.data,
      secret_id: null,
      key_id: keyName,
      outcome: 'error',
      error_code: mapped.code,
      duration_ms: Date.now() - start,
    });
    throw mapped;
  }
}

export const envelope = { encrypt: encryptEnvelope, decrypt: decryptEnvelope };

// ─────────────────────────────────────────────────────────────────────
// KMS key rotation primitives (F02 Slice D D.2)
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-tenant CMEK rotation outcome — captures the version-specific
 * resource names of the previous primary and the newly-promoted
 * primary. Consumed by `tenants.rotateKeys` for the audit chain
 * (TENANT_KEY_ROTATED before_state / after_state envelope).
 */
export interface RotateCryptoKeyResult {
  /** Version-qualified resource name of the previous primary. */
  oldPrimaryVersion: string;
  /** Version-qualified resource name of the new primary. */
  newPrimaryVersion: string;
}

/**
 * Rotate a Cloud KMS crypto-key by creating a new version and
 * promoting it to primary. Used by `tenants.rotateKeys` (F02 Slice D).
 *
 * The crypto-key resource itself (logical key + keyring + project)
 * is stable per ADR-INFRA-007; only the version increments. New
 * encrypt operations on the logical key resource name will use the
 * new primary version automatically; existing ciphertexts continue
 * to decrypt because Cloud KMS auto-detects the encrypting version
 * from the ciphertext metadata (see SD6 + convention §7.2 for the
 * dual-key overlap mechanics — application-layer overlap is
 * functionally infinite via per-payload `keyResourceName` recording).
 *
 * @param keyResourceName fully-qualified logical key resource name
 *   (e.g., `projects/.../keyRings/.../cryptoKeys/cortex-general-key`).
 * @throws KmsUnavailableError on KMS API failure.
 * @throws SecretsError mapped from GCP errors per `mapGcpError`.
 */
async function rotateCryptoKey(keyResourceName: string): Promise<RotateCryptoKeyResult> {
  const start = Date.now();
  const client = getClient();
  try {
    // Read the current primary version before rotation, so the audit
    // chain captures the actual prior version name (not just "the
    // version that was primary at some point in the past").
    const [keyBefore] = await client.getCryptoKey({ name: keyResourceName });
    const oldPrimaryVersion = keyBefore?.primary?.name ?? '';
    if (oldPrimaryVersion === '') {
      throw new SecretsValidationError(
        `KMS rotateCryptoKey: crypto-key has no primary version (key=${keyResourceName})`,
      );
    }

    const [newVersion] = await client.createCryptoKeyVersion({
      parent: keyResourceName,
      cryptoKeyVersion: {},
    });
    const newPrimaryVersion = newVersion?.name ?? '';
    if (newPrimaryVersion === '') {
      throw new SecretsValidationError(
        'KMS rotateCryptoKey: createCryptoKeyVersion returned no version name',
      );
    }

    // Promote to primary. Cloud KMS's updateCryptoKeyPrimaryVersion
    // takes the SHORT version id (the trailing component after the
    // last `/`), not the full resource name.
    const cryptoKeyVersionId = newPrimaryVersion.split('/').pop() ?? '';
    await client.updateCryptoKeyPrimaryVersion({
      name: keyResourceName,
      cryptoKeyVersionId,
    });

    auditLog({
      operation: 'rotateCryptoKey',
      tenant_id: null,
      secret_id: null,
      key_id: newPrimaryVersion,
      outcome: 'ok',
      error_code: null,
      duration_ms: Date.now() - start,
    });

    return { oldPrimaryVersion, newPrimaryVersion };
  } catch (err) {
    const mapped =
      err instanceof SecretsError
        ? err
        : new KmsUnavailableError(String(err), { cause: err as Error });
    auditLog({
      operation: 'rotateCryptoKey',
      tenant_id: null,
      secret_id: null,
      key_id: keyResourceName,
      outcome: 'error',
      error_code: mapped.code,
      duration_ms: Date.now() - start,
    });
    throw mapped;
  }
}

/**
 * Schedule a Cloud KMS crypto-key version for destruction. The actual
 * destruction is delayed by the crypto-key's `destroyScheduledDuration`
 * (configured at crypto-key creation time; SD6 locks 30 days for
 * Cortex's operator-driven rotation flow). Within the window, the
 * version remains DECRYPT-capable so any in-flight payloads encrypted
 * with this version's wrapped DEK continue to decrypt.
 *
 * @param versionResourceName fully-qualified version resource name
 *   (e.g., `projects/.../cryptoKeys/.../cryptoKeyVersions/N`).
 * @throws KmsUnavailableError on KMS API failure.
 */
async function scheduleCryptoKeyVersionDestroy(versionResourceName: string): Promise<void> {
  const start = Date.now();
  const client = getClient();
  try {
    await client.destroyCryptoKeyVersion({ name: versionResourceName });
    auditLog({
      operation: 'scheduleCryptoKeyVersionDestroy',
      tenant_id: null,
      secret_id: null,
      key_id: versionResourceName,
      outcome: 'ok',
      error_code: null,
      duration_ms: Date.now() - start,
    });
  } catch (err) {
    const mapped =
      err instanceof SecretsError
        ? err
        : new KmsUnavailableError(String(err), { cause: err as Error });
    auditLog({
      operation: 'scheduleCryptoKeyVersionDestroy',
      tenant_id: null,
      secret_id: null,
      key_id: versionResourceName,
      outcome: 'error',
      error_code: mapped.code,
      duration_ms: Date.now() - start,
    });
    throw mapped;
  }
}

export const kmsAdmin = {
  rotateCryptoKey,
  scheduleCryptoKeyVersionDestroy,
};

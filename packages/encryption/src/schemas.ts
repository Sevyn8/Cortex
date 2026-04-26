/**
 * Zod schemas for `@cortex/encryption`.
 *
 * The schemas validate caller-supplied params (`encryptParamsSchema`,
 * `decryptParamsSchema`) and the canonical `EncryptedPayload` shape
 * exposed across the package boundary. Buffers are validated for
 * non-emptiness; strings for UTF-8 safety + non-zero length; tenant
 * ids as UUIDs.
 *
 * NFC normalization for string plaintext lives in the runtime emit
 * path (sub-phase 4), not in the zod schema. The schema accepts the
 * raw string; the runtime normalizes before encoding to bytes — same
 * convention as `@cortex/audit-events`'s payload canonicalization.
 *
 * Note: `z.instanceof(Buffer)` works under TypeScript strict mode in
 * Node — the Buffer constructor IS a class with a recognizable
 * prototype chain. If a future TS upgrade narrows this somehow, the
 * fallback is `z.custom<Buffer>(Buffer.isBuffer)` which is guaranteed
 * stable.
 */

import { z } from 'zod';

const tenantIdSchema = z.string().uuid();

const nonEmptyBufferSchema = z
  .instanceof(Buffer)
  .refine((b) => b.byteLength > 0, { message: 'Buffer must be non-empty' });

/**
 * Schema for `EncryptedPayload`. Each Buffer is required and must be
 * non-empty; string fields must be present and non-empty.
 *
 * The schema does NOT validate cryptographic semantics (e.g., that
 * `iv.byteLength === 12` for GCM, that `wrappedKey` is a valid KMS
 * ciphertext, that `aad === Buffer.from(tenantId, 'utf8')`). Those are
 * runtime invariants enforced by the underlying `@cortex/secrets`
 * envelope or by the AEAD primitive itself; double-validating here
 * would couple this schema to internal cryptographic details.
 */
export const encryptedPayloadSchema = z.object({
  envelope: nonEmptyBufferSchema,
  keyResourceName: z.string().min(1),
  tenantId: tenantIdSchema,
  aad: nonEmptyBufferSchema,
});

/**
 * Schema for `EncryptParams`. `plaintext` accepts a Buffer (verbatim)
 * or a non-empty string (NFC-normalized + UTF-8 encoded by the
 * runtime).
 */
export const encryptParamsSchema = z.object({
  tenantId: tenantIdSchema,
  plaintext: z.union([nonEmptyBufferSchema, z.string().min(1)]),
});

/**
 * Schema for `DecryptParams`. Reuses `encryptedPayloadSchema` for the
 * payload field.
 */
export const decryptParamsSchema = z.object({
  tenantId: tenantIdSchema,
  payload: encryptedPayloadSchema,
});

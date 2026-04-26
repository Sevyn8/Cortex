/**
 * Zod schemas for `@cortex/audit-events`.
 *
 * Per planning-doc Decision 2, the library is the canonicalization
 * boundary — zod schemas enforce:
 *   - Unicode NFC normalization on every string (top-level + nested in
 *     payload / before_state / after_state) at parse time
 *   - JSON-safe value types only (string / number / boolean / null /
 *     array / object); BigInt, Symbol, undefined, Function, Date are
 *     rejected
 *   - Action-name regex (`AUDIT_ACTION_NAME_REGEX`) at the schema layer
 *     for redundant defense (registration is the primary enforcement;
 *     the schema catches drift if a brand is forged)
 *   - Per-verb discriminated union — CREATE requires `after_state`,
 *     UPDATE requires both, DELETE requires `before_state`, READ
 *     forbids both, APPROVE/REJECT/EXECUTE accept either or both
 *
 * Payload-size enforcement is NOT done here — it requires JSON
 * serialization, which lives in the emit path (sub-phase 4) where the
 * library logs WARN above `SOFT_PAYLOAD_LIMIT_BYTES` per Decision 2.
 *
 * Timestamp coercion (ISO-8601 µs strings inside payload) is the
 * caller's responsibility per ADR-DB-003 §3. The schema cannot
 * heuristically detect timestamp-shaped strings without false-positive
 * risk on legitimate data (order IDs, internal sequences, etc.).
 */

import { z } from 'zod';
import { AUDIT_ACTION_NAME_REGEX, type JsonObject, type JsonValue } from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Recursive JSON-safe value schema
// ─────────────────────────────────────────────────────────────────────

/**
 * Recursive zod schema for `JsonValue`. Strings normalized to NFC at
 * parse. Rejects every non-JSON-safe value type (BigInt, Symbol,
 * undefined, Function, Date) by construction — the union has no
 * variant for them.
 *
 * `z.lazy` lets the schema reference itself for nested arrays/objects.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().transform((s) => s.normalize('NFC')),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * Recursive zod schema for `JsonObject` (the top-level shape of
 * `payload` / `before_state` / `after_state`). Keyed by NFC-normalized
 * strings; values pass through `jsonValueSchema`.
 */
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

// ─────────────────────────────────────────────────────────────────────
// Common-field schema (used by every per-verb variant)
// ─────────────────────────────────────────────────────────────────────

const commonFields = {
  tenantId: z.string().uuid(),
  actorType: z.enum(['service', 'user', 'system', 'agent']),
  actorId: z
    .string()
    .min(1)
    .max(255)
    .transform((s) => s.normalize('NFC')),
  actorDescription: z
    .string()
    .max(1024)
    .transform((s) => s.normalize('NFC'))
    .optional(),
  action: z.object({
    name: z.string().regex(AUDIT_ACTION_NAME_REGEX, 'action name must match /^[A-Z][A-Z0-9_]*$/'),
    verb: z.enum(['CREATE', 'READ', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'EXECUTE']),
  }),
  resource: z
    .string()
    .min(1)
    .max(255)
    .transform((s) => s.normalize('NFC')),
  sessionId: z.string().max(255).optional(),
  requestId: z.string().max(255).optional(),
  ipAddress: z.string().max(64).optional(),
  userAgent: z.string().max(1024).optional(),
  workspaceId: z.string().max(255).optional(),
  payload: jsonObjectSchema.optional(),
};

// ─────────────────────────────────────────────────────────────────────
// Per-verb schemas — each declares the before/after-state contract
// ─────────────────────────────────────────────────────────────────────

export const auditEventCreateSchema = z.object({
  ...commonFields,
  verb: z.literal('CREATE'),
  before_state: z.undefined().optional(),
  after_state: jsonObjectSchema,
});

export const auditEventReadSchema = z.object({
  ...commonFields,
  verb: z.literal('READ'),
  before_state: z.undefined().optional(),
  after_state: z.undefined().optional(),
});

export const auditEventUpdateSchema = z.object({
  ...commonFields,
  verb: z.literal('UPDATE'),
  before_state: jsonObjectSchema,
  after_state: jsonObjectSchema,
});

export const auditEventDeleteSchema = z.object({
  ...commonFields,
  verb: z.literal('DELETE'),
  before_state: jsonObjectSchema,
  after_state: z.undefined().optional(),
});

export const auditEventApproveSchema = z.object({
  ...commonFields,
  verb: z.literal('APPROVE'),
  before_state: jsonObjectSchema.optional(),
  after_state: jsonObjectSchema.optional(),
});

export const auditEventRejectSchema = z.object({
  ...commonFields,
  verb: z.literal('REJECT'),
  before_state: jsonObjectSchema.optional(),
  after_state: jsonObjectSchema.optional(),
});

export const auditEventExecuteSchema = z.object({
  ...commonFields,
  verb: z.literal('EXECUTE'),
  before_state: jsonObjectSchema.optional(),
  after_state: jsonObjectSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────
// Top-level discriminated union
// ─────────────────────────────────────────────────────────────────────

/**
 * Top-level audit-event params schema, discriminated on `verb`. Caller
 * passes one variant; zod selects the matching per-verb schema for
 * validation and surfaces field-level issues if the variant constraints
 * (CREATE missing `after_state`, UPDATE missing `before_state` /
 * `after_state`, READ supplying either, etc.) are violated.
 */
export const auditEventParamsSchema = z.discriminatedUnion('verb', [
  auditEventCreateSchema,
  auditEventReadSchema,
  auditEventUpdateSchema,
  auditEventDeleteSchema,
  auditEventApproveSchema,
  auditEventRejectSchema,
  auditEventExecuteSchema,
]);

/**
 * Zod schemas for `@cortex/quotas`.
 *
 * Validates caller-supplied params (`checkQuotaParamsSchema`) and the
 * tier discriminator. The `resourceClass` enum is derived from the
 * `RESOURCE_CLASSES` const tuple — adding a value to that tuple
 * automatically extends the schema.
 *
 * **Note on `z.bigint()`:** zod's bigint support is stable since 3.20.
 * `nonnegative()` accepts 0n and positive bigints; `min(0n)` is the
 * equivalent. Errors surface as `ZodError` with `code: 'too_small'` /
 * `code: 'invalid_type'`. JSON-serialization of bigint values is
 * caller-side concern — zod parses + validates fine, but consumers
 * must `String(value)` or convert at boundaries.
 */

import { z } from 'zod';
import { RESOURCE_CLASSES, type ResourceClass } from './types.js';

const tenantIdSchema = z.string().uuid();

/**
 * `ResourceClass` enum. Cast through `[...RESOURCE_CLASSES]` to satisfy
 * zod's `z.enum` signature requiring a non-empty tuple of literals.
 * The `as const` on `RESOURCE_CLASSES` (in `types.ts`) preserves the
 * literal-union narrowing.
 */
export const resourceClassSchema = z.enum(
  RESOURCE_CLASSES as readonly [ResourceClass, ...ResourceClass[]],
);

/** Tier discriminator. Mirrors `tenant.tier` CHECK constraint. */
export const quotaTierSchema = z.enum(['STANDARD', 'ENTERPRISE']);

/**
 * Caller input schema for `checkQuota`. `increment` is non-negative
 * bigint; 0n is permitted (no-op check, useful for testing the
 * current-value reading without consuming).
 */
export const checkQuotaParamsSchema = z.object({
  tenantId: tenantIdSchema,
  resourceClass: resourceClassSchema,
  increment: z.bigint().nonnegative(),
});

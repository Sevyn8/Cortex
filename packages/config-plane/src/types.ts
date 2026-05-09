/**
 * Shared types + zod schemas for `@cortex/config-plane` lifecycle.
 * Mirrors the `@cortex/tenant-context` actor pattern (F02 precedent)
 * — F04 lifecycle helpers accept an Actor and record actor.id as the
 * draft's `created_by_user_id`.
 *
 * Actor type defined here (not imported from tenant-context) to keep
 * the dependency graph as a leaf: `@cortex/config-plane` depends on
 * `@cortex/audit-events` + `@cortex/canonical-schema` + `@cortex/
 * secrets` (transitive); importing tenant-context's Actor would
 * couple two parallel lifecycle modules through a type that can be
 * cheaply duplicated.
 */

import { z } from 'zod';

export const actorSchema = z.object({
  type: z.enum(['service', 'user', 'system']),
  id: z.string().min(1).max(255),
  description: z.string().max(1024).optional(),
});

export type Actor = z.infer<typeof actorSchema>;

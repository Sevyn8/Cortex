/**
 * P1.6 Slice B — minimal error → RFC 9457 problem-details mapper.
 *
 * Used by `hono-problem-details`'s `problemDetailsHandler({ mapError })`
 * per ADR-HTTP-001 Condition 5.
 *
 * P1.6 has very few error types — bulk-fetch can fail on missing
 * tenant header (`TenantContextMissingError` from `@cortex/tenant-context`)
 * or on internal eval errors (Zod validation failures from F04 pinned
 * schemas, RLS denials). Slice B's surface is small; this mapper
 * delegates everything-else to the framework default (500 INTERNAL).
 */
import { TenantContextMissingError, TenantValidationError } from '@cortex/tenant-context';
import type { ProblemDetailsInput } from 'hono-problem-details';

export type CortexProblemExtensions = {
  code: string;
} & Record<string, unknown>;

export function mapError(err: Error): ProblemDetailsInput<CortexProblemExtensions> | undefined {
  // Middleware throws TenantValidationError when `x-cortex-tenant-id`
  // header is missing AND `rejectMissingTenant: true` (per
  // @cortex/tenant-context middleware contract).
  if (err instanceof TenantValidationError) {
    return {
      status: 400,
      title: 'VALIDATION',
      detail: err.message,
      extensions: { code: 'TENANT_CONTEXT_MISSING' },
    };
  }

  // Defensive — for routes that read the bound context directly,
  // `TenantContextMissingError` surfaces if a caller skipped the
  // middleware. Same 400 semantics.
  if (err instanceof TenantContextMissingError) {
    return {
      status: 400,
      title: 'VALIDATION',
      detail: 'tenant context not bound (middleware not configured?)',
      extensions: { code: 'TENANT_CONTEXT_MISSING' },
    };
  }

  // Fall through to the library's default 500 mapping.
  return undefined;
}

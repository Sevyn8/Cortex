/**
 * Centralized error → RFC 9457 problem-details mapper.
 *
 * Used by `hono-problem-details`'s `problemDetailsHandler({mapError})`
 * per ADR-HTTP-001 Condition 5. Returns a `ProblemDetailsInput` shape;
 * the library serializes to `application/problem+json` with the
 * standard 5 fields (type / status / title / detail / instance) plus
 * extension members carrying the workspace-extended envelope per
 * CLAUDE.md §"Error responses": `{code, correlation_id, details?}`.
 *
 * HTTP-status alignment per CLAUDE.md: 400 VALIDATION / 401 UNAUTH /
 * 403 FORBIDDEN / 404 NOT_FOUND / 409 CONFLICT / 422 BUSINESS_RULE /
 * 429 RATE_LIMIT / 500 INTERNAL.
 */
import {
  TenantContextMissingError,
  TenantGraceNotElapsedError,
  TenantLegalHoldError,
  TenantNotFoundError,
  TenantStatusError,
  TenantValidationError,
} from '@cortex/tenant-context';
import { createLogger, getCorrelationId, type Logger } from '@cortex/observability';
import type { ProblemDetailsInput } from 'hono-problem-details';

export type CortexProblemExtensions = {
  code: string;
  correlation_id?: string;
  details?: Record<string, unknown>;
} & Record<string, unknown>;

// Lazy-initialized observability logger for unhandled errors. The
// production-safe response sent to the client stays generic ("An
// unexpected error occurred"); the server-side log captures the
// original error message + stack so D.3+ diagnostics aren't blind.
// Lazy so the logger isn't constructed at module-eval time (keeps
// cold-start instrumentation per ADR-HTTP-001 Condition 2 clean).
let cachedLogger: Logger | undefined;
function getErrorLogger(): Logger {
  cachedLogger ??= createLogger({ moduleId: 'tenant-lifecycle-api' });
  return cachedLogger;
}

export function mapError(err: Error): ProblemDetailsInput<CortexProblemExtensions> | undefined {
  const correlation_id = getCorrelationId();
  const baseExt = (code: string): CortexProblemExtensions =>
    correlation_id !== undefined ? { code, correlation_id } : { code };

  if (err instanceof TenantValidationError) {
    return {
      status: 400,
      title: 'VALIDATION',
      detail: err.message,
      extensions: baseExt('VALIDATION'),
    };
  }
  if (err instanceof TenantContextMissingError) {
    return {
      status: 400,
      title: 'TENANT_CONTEXT_MISSING',
      detail: err.message,
      extensions: baseExt('TENANT_CONTEXT_MISSING'),
    };
  }
  if (err instanceof TenantNotFoundError) {
    return {
      status: 404,
      title: 'NOT_FOUND',
      detail: err.message,
      extensions: baseExt('NOT_FOUND'),
    };
  }
  if (err instanceof TenantStatusError) {
    return {
      status: 409,
      title: 'CONFLICT',
      detail: err.message,
      extensions: baseExt('CONFLICT'),
    };
  }
  if (err instanceof TenantLegalHoldError) {
    return {
      status: 409,
      title: 'LEGAL_HOLD',
      detail: err.message,
      extensions: baseExt('LEGAL_HOLD'),
    };
  }
  if (err instanceof TenantGraceNotElapsedError) {
    return {
      status: 409,
      title: 'GRACE_NOT_ELAPSED',
      detail: err.message,
      extensions: baseExt('GRACE_NOT_ELAPSED'),
    };
  }

  // Unhandled error path → 500. Log the original message + stack to
  // the observability logger BEFORE returning undefined (which hands
  // control back to problemDetailsHandler's generic "Internal Server
  // Error" response). The production-safe response stays generic; the
  // server-side log captures the detail so D.3+ diagnostics aren't
  // blind. Correlation_id (when present) ties the log line to the
  // client's request.
  getErrorLogger().error(
    {
      err: { message: err.message, stack: err.stack, name: err.name },
      ...(correlation_id !== undefined && { correlation_id }),
    },
    'unhandled error in HTTP route',
  );
  return undefined;
}

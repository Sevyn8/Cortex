/**
 * Framework-agnostic HTTP middleware primitives for tenant context.
 *
 * Phase 1 has no concrete F-service exposing HTTP yet, so this module
 * does not commit to a framework. It exposes the extraction + validation
 * core plus thin Hono and Express adapters that can be dropped into
 * either ecosystem. The choice of framework — or whether to keep the
 * agnostic shape permanently — is recorded in
 * docs/future-roadmap.md §10.
 *
 * Pipeline:
 *   1. extract — pull the tenant id from the request headers (default:
 *      `x-cortex-tenant-id`, case-insensitive).
 *   2. validate — optionally run a caller-supplied async check (e.g.,
 *      "tenant exists and is ACTIVE").
 *   3. bind — call `withTenantContext(tenantId, downstream)` so the
 *      async-local store is set for the entire request lifecycle.
 *   4. cleanup — happens automatically when the async context unwinds;
 *      no explicit clearStore call needed.
 *
 * Failure modes (all surfaced as thrown errors that the framework's
 * error handler converts to HTTP responses):
 *   - missing header + rejectMissingTenant=true → TenantValidationError
 *   - validateTenant throws → propagated as-is
 *
 * Skipped paths (default empty) bypass the middleware entirely — no
 * extraction, no async-local binding. Typical: /health, /readiness.
 */

import { withTenantContext } from './context.js';
import { TenantValidationError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Pulls a tenant id out of an incoming request's headers. Return
 * `undefined` if no candidate is present (the middleware decides what
 * to do based on `rejectMissingTenant`).
 */
export type TenantExtractor = (request: {
  headers: Record<string, string | string[] | undefined>;
}) => string | undefined;

const TENANT_HEADER = 'x-cortex-tenant-id';

/**
 * Default extractor — reads `x-cortex-tenant-id` (case-insensitive).
 * Multi-value headers take the first entry.
 */
export const defaultHeaderExtractor: TenantExtractor = (request) => {
  for (const key of Object.keys(request.headers)) {
    if (key.toLowerCase() !== TENANT_HEADER) continue;
    const value = request.headers[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
};

export interface TenantContextMiddlewareOptions {
  /** Override the default header-based extractor. */
  extractor?: TenantExtractor;

  /**
   * Optional async hook to verify the extracted tenant exists and is in
   * an acceptable status. Closures over the caller's DB client; throws
   * (e.g., `TenantNotFoundError`, `TenantStatusError`) propagate to the
   * framework error handler.
   */
  validateTenant?: (tenantId: string) => Promise<void>;

  /**
   * Paths that bypass the middleware entirely (exact match). Typical:
   * `['/health', '/readiness']`.
   */
  skipPaths?: string[];

  /**
   * If `true` (default), requests missing the tenant header fail with
   * `TenantValidationError`. If `false`, they pass through with no
   * async-local binding — downstream handlers calling `getTenantOrThrow`
   * will then throw `TenantContextMissingError` themselves.
   */
  rejectMissingTenant?: boolean;
}

/**
 * Hono context shape used by the adapter. Defined locally so this
 * package does not take a runtime dependency on Hono — the adapter just
 * accepts any object that quacks like Hono's context.
 */
interface HonoContextLike {
  req: {
    raw: { headers: Headers };
    path: string;
  };
}

type HonoNext = () => Promise<void>;

/**
 * Express request shape used by the adapter. Same rationale as the
 * Hono types — structural, no runtime import.
 */
interface ExpressRequestLike {
  headers: Record<string, string | string[] | undefined>;
  path: string;
}

type ExpressNext = (err?: unknown) => void;

export interface TenantContextMiddleware {
  hono(c: HonoContextLike, next: HonoNext): Promise<void>;
  express(req: ExpressRequestLike, res: unknown, next: ExpressNext): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

function honoHeadersToRecord(headers: Headers): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

interface ResolvedOptions {
  extractor: TenantExtractor;
  validateTenant: ((tenantId: string) => Promise<void>) | undefined;
  skipPaths: ReadonlySet<string>;
  rejectMissingTenant: boolean;
}

function resolveOptions(options: TenantContextMiddlewareOptions | undefined): ResolvedOptions {
  return {
    extractor: options?.extractor ?? defaultHeaderExtractor,
    validateTenant: options?.validateTenant,
    skipPaths: new Set(options?.skipPaths ?? []),
    rejectMissingTenant: options?.rejectMissingTenant ?? true,
  };
}

/**
 * Core extraction + validation, framework-agnostic. The caller passes
 * the request's headers + path and a `runDownstream` callback; this
 * function decides whether to skip, reject, or wrap the callback in
 * `withTenantContext`.
 */
async function handle(
  resolved: ResolvedOptions,
  headers: Record<string, string | string[] | undefined>,
  path: string,
  runDownstream: () => void | Promise<void>,
): Promise<void> {
  if (resolved.skipPaths.has(path)) {
    await runDownstream();
    return;
  }

  const tenantId = resolved.extractor({ headers });

  if (tenantId === undefined) {
    if (resolved.rejectMissingTenant) {
      throw new TenantValidationError(`Request missing required header: ${TENANT_HEADER}`);
    }
    await runDownstream();
    return;
  }

  if (resolved.validateTenant !== undefined) {
    await resolved.validateTenant(tenantId);
  }

  await withTenantContext(tenantId, runDownstream);
}

// ─────────────────────────────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a tenant-context middleware. Returns adapter methods for
 * supported frameworks. Each adapter shares the same extraction +
 * validation core; pick whichever matches the host service's framework.
 */
export function buildTenantContextMiddleware(
  options?: TenantContextMiddlewareOptions,
): TenantContextMiddleware {
  const resolved = resolveOptions(options);

  return {
    async hono(c, next) {
      const headers = honoHeadersToRecord(c.req.raw.headers);
      await handle(resolved, headers, c.req.path, async () => {
        await next();
      });
    },

    async express(req, _res, next) {
      try {
        await handle(resolved, req.headers, req.path, () => {
          next();
        });
      } catch (err) {
        next(err);
      }
    },
  };
}

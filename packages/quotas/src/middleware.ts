/**
 * Framework-agnostic HTTP middleware for `@cortex/quotas`.
 *
 * The middleware checks the per-tenant token bucket on each request,
 * issues 429 with `Retry-After` when exhausted, and emits the
 * `QUOTA_EXCEEDED` audit event (per planning-doc Decision 9). The
 * pure-logic core (`buildQuotaMiddlewareCore`) is exposed for non-HTTP
 * consumers; the Hono and Express adapters wrap it with the host
 * framework's request / response shape.
 *
 * **Composition order** (recommended):
 *
 *   observability → tenant-context → quotas → handler
 *
 * Quota check requires `bindTenantToDbSession` to have already been
 * called by `@cortex/tenant-context`'s middleware — both the
 * `tenant_quota_usage` upsert AND the `QUOTA_EXCEEDED` audit emission
 * require RLS to be satisfied. Outermost observability ensures any
 * 429-path log lines carry the correlation id.
 *
 * **No runtime dep on `@cortex/tenant-context`.** Following the
 * established convention (see `getDb`), tenantId resolution is also
 * caller-supplied via `resolveTenantId(request)`. Typical wiring:
 * `resolveTenantId: () => getTenantOrThrow()` from the host service's
 * scope. This keeps `@cortex/quotas` itself decoupled from
 * tenant-context at runtime.
 *
 * Mirrors `@cortex/tenant-context/src/middleware.ts` in shape:
 * structural duck-typed interfaces, no Hono / Express runtime imports.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { checkQuota } from './check-quota.js';
import { getQuotaConfig } from './config.js';
import type { CheckQuotaResult, QuotaTier, ResourceClass } from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Caller-supplied resolvers + policy options. The middleware is
 * deliberately decoupled from any specific host framework or async-
 * local source — every runtime value is threaded via a resolver
 * function the caller wires in their own scope.
 *
 * Typical usage from a host service:
 *
 * ```ts
 * import { honoQuotaMiddleware } from '@cortex/quotas';
 * import { getTenantOrThrow, tenants } from '@cortex/tenant-context';
 *
 * const m = honoQuotaMiddleware({
 *   resolveResourceClass: ({ method }) => method === 'GET' ? 'api_calls_per_minute' : 'api_calls_per_minute',
 *   resolveTenantId: () => getTenantOrThrow(),
 *   resolveTier: async (tenantId) => (await tenants.get(db, tenantId)).tier,
 *   getDb: (c) => c.var.tx,
 *   skipPaths: ['/health', '/readiness'],
 * });
 * ```
 */
export interface QuotaMiddlewareOptions {
  /**
   * Pick the resource class to check for this request — typically
   * `'api_calls_per_minute'` for HTTP, but consumers can vary by
   * route / method (e.g., a /metrics route counted under a different
   * class). Returning `null` skips the check for this request.
   */
  resolveResourceClass: (request: { method: string; path: string }) => ResourceClass | null;

  /**
   * Resolve the request's tenant id. Typical wiring:
   * `() => getTenantOrThrow()` from `@cortex/tenant-context`. Receives
   * the host-framework request object so callers can use whatever
   * extraction strategy fits (async-local, header, request var, etc.).
   */
  resolveTenantId: (request: unknown) => string;

  /**
   * Resolve the tenant's commercial tier. Typical wiring:
   * `async (tenantId) => (await tenants.get(db, tenantId)).tier`.
   * Cached resolution is the caller's responsibility — the middleware
   * calls this on every request.
   */
  resolveTier: (tenantId: string) => Promise<QuotaTier>;

  /**
   * Provide the request-scoped DB instance. Typical wiring:
   * `(c) => c.var.tx` if the host service uses Hono variables;
   * `(req) => req.db` for Express; or call into a request-scoped
   * factory.
   */
  getDb: (request: unknown) => NodePgDatabase<Record<string, never>>;

  /**
   * How much to consume from the bucket per request. Defaults to `1n`
   * (per-request counters like `api_calls_per_minute`). For
   * accumulating resources (`cpu_seconds`, `ram_mb`), callers may
   * compute the consumed amount based on response time, payload size,
   * etc. — this resolver fires AFTER the request resolves but BEFORE
   * the response is committed in Slice C; revisit if the timing
   * changes.
   */
  resolveIncrement?: (request: unknown) => bigint;

  /**
   * Paths that bypass the middleware entirely. Exact-match. Typical:
   * `['/health', '/readiness', '/metrics']`.
   */
  skipPaths?: readonly string[];

  /**
   * Optional explicit quota limit override per `(tenantId,
   * resourceClass)`. When supplied and the resolver returns a value,
   * that value takes precedence over `getQuotaConfig(tier,
   * resourceClass)`. F02 will use this to thread per-tenant
   * `tenant_config_version.config_json.quotas[resource_class]`
   * overrides; until then, `undefined` (or omitting the option) lets
   * `getQuotaConfig` apply the per-tier default.
   */
  resolveQuotaLimit?: (
    tenantId: string,
    resourceClass: ResourceClass,
  ) => Promise<bigint | undefined>;
}

/**
 * Result of `QuotaMiddlewareCore.check`. Pure-logic shape; HTTP
 * adapters translate this to 429 + JSON body + `Retry-After` header.
 */
export type QuotaCheckOutcome =
  | { allowed: true; result: CheckQuotaResult | null }
  | {
      allowed: false;
      currentValue: bigint;
      quotaLimit: bigint;
      retryAfterSeconds: number;
      resourceClass: ResourceClass;
    };

export interface QuotaMiddlewareCore {
  check(request: {
    method: string;
    path: string;
    tenantId: string;
    db: NodePgDatabase<Record<string, never>>;
    increment: bigint;
  }): Promise<QuotaCheckOutcome>;
}

// ─────────────────────────────────────────────────────────────────────
// Framework-Like interfaces (no runtime imports)
// ─────────────────────────────────────────────────────────────────────

/** Hono context shape used by the adapter. Structural; no Hono import. */
interface HonoContextLike {
  req: { method: string; path: string };
  json: (
    data: unknown,
    status?: number,
    headers?: Record<string, string>,
  ) => Response | Promise<Response>;
}

type HonoNext = () => Promise<void>;

/** Express request shape used by the adapter. Structural; no Express import. */
interface ExpressRequestLike {
  method: string;
  path: string;
}

interface ExpressResponseLike {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ExpressResponseLike;
  json: (body: unknown) => ExpressResponseLike;
}

type ExpressNext = (err?: unknown) => void;

// ─────────────────────────────────────────────────────────────────────
// Framework-agnostic core
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the framework-agnostic quota-check core. The `check` method
 * runs the policy: skip-list → resolve resource class → resolve
 * tier + limit → consume from the bucket → return outcome.
 *
 * Catches `QuotaExceededError` and returns a structured outcome so
 * adapters can translate to their host framework's response shape
 * without re-throwing through framework error handlers.
 */
export function buildQuotaMiddlewareCore(opts: QuotaMiddlewareOptions): QuotaMiddlewareCore {
  const skipPaths = new Set(opts.skipPaths ?? []);

  return {
    async check({ method, path, tenantId, db, increment }) {
      if (skipPaths.has(path)) {
        return { allowed: true, result: null };
      }

      const resourceClass = opts.resolveResourceClass({ method, path });
      if (resourceClass === null) {
        return { allowed: true, result: null };
      }

      const tier = await opts.resolveTier(tenantId);
      const override =
        opts.resolveQuotaLimit !== undefined
          ? await opts.resolveQuotaLimit(tenantId, resourceClass)
          : undefined;
      // F02 Slice A swap (sub-phase 5.3): getQuotaConfig now consults
      // tenant_config_version for per-tenant overrides when ctx supplies
      // tenantId + db. Both are already in scope from the middleware's
      // request context, so per-tenant overrides light up automatically.
      // resolveQuotaLimit (caller-supplied override) still wins via the
      // `??` short-circuit.
      const quotaLimit = override ?? (await getQuotaConfig(tier, resourceClass, { tenantId, db }));

      // checkQuota returns a discriminated result (no throw on
      // exceedance — see types.ts CheckQuotaResult JSDoc). Translate
      // the result directly into the middleware outcome shape.
      const result = await checkQuota(
        db,
        { tenantId, resourceClass, increment },
        { tier, quotaLimit },
      );
      if (!result.allowed) {
        return {
          allowed: false,
          currentValue: result.currentValue,
          quotaLimit: result.quotaLimit,
          retryAfterSeconds: result.retryAfterSeconds,
          resourceClass: result.resourceClass,
        };
      }
      return { allowed: true, result };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Hono adapter
// ─────────────────────────────────────────────────────────────────────

/**
 * Hono middleware factory. Returns `(c, next) => …` matching Hono's
 * middleware contract. On 429, returns the JSON 429 response directly
 * (short-circuits the chain) with `Retry-After` set; on success,
 * calls `next()`.
 *
 * BigInt values are converted to strings at the response boundary
 * (per planning-doc Decision 8 serialization note).
 */
export function honoQuotaMiddleware(
  opts: QuotaMiddlewareOptions,
): (c: HonoContextLike, next: HonoNext) => Promise<Response | void> {
  const core = buildQuotaMiddlewareCore(opts);
  const resolveIncrement = opts.resolveIncrement ?? (() => 1n);

  return async (c, next) => {
    const tenantId = opts.resolveTenantId(c);
    const db = opts.getDb(c);
    const increment = resolveIncrement(c);
    const outcome = await core.check({
      method: c.req.method,
      path: c.req.path,
      tenantId,
      db,
      increment,
    });

    if (!outcome.allowed) {
      return c.json(
        {
          code: 'QUOTA_EXCEEDED',
          resource_class: outcome.resourceClass,
          current_value: outcome.currentValue.toString(),
          quota_limit: outcome.quotaLimit.toString(),
          retry_after_seconds: outcome.retryAfterSeconds,
        },
        429,
        { 'Retry-After': String(outcome.retryAfterSeconds) },
      );
    }

    await next();
    return undefined;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Express adapter
// ─────────────────────────────────────────────────────────────────────

/**
 * Express middleware factory. Returns `(req, res, next) => …`. On 429,
 * sets `Retry-After`, sends 429 + JSON body, does NOT call `next()`.
 * On success, calls `next()`. Errors propagate via `next(err)`.
 */
export function expressQuotaMiddleware(
  opts: QuotaMiddlewareOptions,
): (req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNext) => Promise<void> {
  const core = buildQuotaMiddlewareCore(opts);
  const resolveIncrement = opts.resolveIncrement ?? (() => 1n);

  return async (req, res, next) => {
    try {
      const tenantId = opts.resolveTenantId(req);
      const db = opts.getDb(req);
      const increment = resolveIncrement(req);
      const outcome = await core.check({
        method: req.method,
        path: req.path,
        tenantId,
        db,
        increment,
      });

      if (!outcome.allowed) {
        res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        res.status(429).json({
          code: 'QUOTA_EXCEEDED',
          resource_class: outcome.resourceClass,
          current_value: outcome.currentValue.toString(),
          quota_limit: outcome.quotaLimit.toString(),
          retry_after_seconds: outcome.retryAfterSeconds,
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

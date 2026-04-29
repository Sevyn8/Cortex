/**
 * Error hierarchy for @cortex/tenant-context.
 *
 * All errors extend `TenantContextError`. Callers can `instanceof
 * TenantContextError` to catch any package-emitted failure, or narrow on
 * `.code` to discriminate. Subclasses set `.name` so stack traces and JSON
 * serialization carry the specific class identity.
 */

export type TenantContextErrorCode =
  | 'CONTEXT_MISSING'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_STATUS'
  | 'TENANT_LEGAL_HOLD'
  | 'TENANT_GRACE_NOT_ELAPSED'
  | 'TENANT_ROTATION_COOLDOWN'
  | 'VALIDATION';

export class TenantContextError extends Error {
  readonly code: TenantContextErrorCode;

  constructor(code: TenantContextErrorCode, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.code = code;
    this.name = 'TenantContextError';
  }
}

/**
 * Thrown by `getTenantOrThrow` when the async-local context store is empty,
 * or by helpers that require a bound tenant context to operate (e.g.,
 * `ensureBoundToTenant`).
 */
export class TenantContextMissingError extends TenantContextError {
  constructor(message = 'Tenant context required but not set', options?: { cause?: Error }) {
    super('CONTEXT_MISSING', message, options);
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Thrown when a lookup by id or external_id finds no matching tenant row.
 * `kind` discriminates which identifier the caller passed in.
 */
export class TenantNotFoundError extends TenantContextError {
  readonly identifier: string;
  readonly kind: 'id' | 'external_id';

  constructor(identifier: string, kind: 'id' | 'external_id' = 'id', options?: { cause?: Error }) {
    super('TENANT_NOT_FOUND', `Tenant not found: ${kind}=${identifier}`, options);
    this.identifier = identifier;
    this.kind = kind;
    this.name = 'TenantNotFoundError';
  }
}

/**
 * Thrown when a tenant exists but its `status` disqualifies the requested
 * operation (e.g., trying to update a TERMINATED tenant). Carries the
 * actual status and the set of expected statuses for diagnostics.
 */
export class TenantStatusError extends TenantContextError {
  readonly tenantId: string;
  readonly currentStatus: string;
  readonly expectedStatuses: readonly string[];

  constructor(
    tenantId: string,
    currentStatus: string,
    expectedStatuses: readonly string[],
    options?: { cause?: Error },
  ) {
    super(
      'TENANT_STATUS',
      `Tenant ${tenantId} has status ${currentStatus}; expected one of [${expectedStatuses.join(', ')}]`,
      options,
    );
    this.tenantId = tenantId;
    this.currentStatus = currentStatus;
    this.expectedStatuses = expectedStatuses;
    this.name = 'TenantStatusError';
  }
}

/**
 * Thrown by zod validation failures (invalid tenantId UUID, malformed
 * input to `tenants.create`, etc.). Caller passes the concrete failure
 * message; `cause` is typically a ZodError.
 */
export class TenantValidationError extends TenantContextError {
  constructor(message: string, options?: { cause?: Error }) {
    super('VALIDATION', message, options);
    this.name = 'TenantValidationError';
  }
}

/**
 * Thrown by `tenants.terminate` when an active legal hold blocks the
 * destructive operation. Two-tier check per F02 Slice C convention §6.3:
 * the per-tenant fast path (`tenant.legal_hold` boolean) and the
 * granular `legal_hold` table (scope: tenant / record / data_class).
 *
 * Carries structured fields for operator forensics. Use
 * `tenants.forceTerminate` for the Super Admin override.
 */
export class TenantLegalHoldError extends TenantContextError {
  readonly tenantId: string;
  readonly holdScope: 'tenant' | 'record' | 'data_class';
  readonly holdReason: string;
  readonly setByUserId: string;

  constructor(
    tenantId: string,
    holdScope: 'tenant' | 'record' | 'data_class',
    holdReason: string,
    setByUserId: string,
    options?: { cause?: Error },
  ) {
    super(
      'TENANT_LEGAL_HOLD',
      `Tenant ${tenantId} has active legal hold (scope=${holdScope}); ` +
        `cannot terminate. Hold reason: ${JSON.stringify(holdReason)} (set by ${setByUserId}). ` +
        `Use tenants.forceTerminate for Super Admin override.`,
      options,
    );
    this.tenantId = tenantId;
    this.holdScope = holdScope;
    this.holdReason = holdReason;
    this.setByUserId = setByUserId;
    this.name = 'TenantLegalHoldError';
  }
}

/**
 * Thrown by `tenants.terminate` when invoked before the offboarding
 * grace period has elapsed (`now() < tenant.offboarding_grace_until`).
 * Distinct from `TenantStatusError`: the status IS valid (OFFBOARDING),
 * but a different precondition is unmet (time-based). Q-NEW-C10 lock:
 * strict comparison — no tolerance window for Cloud Tasks dispatch
 * jitter; trust retry semantics instead.
 */
export class TenantGraceNotElapsedError extends TenantContextError {
  readonly tenantId: string;
  readonly graceUntil: Date;
  readonly now: Date;

  constructor(tenantId: string, graceUntil: Date, now: Date, options?: { cause?: Error }) {
    super(
      'TENANT_GRACE_NOT_ELAPSED',
      `Tenant ${tenantId} grace period not elapsed: ` +
        `grace_until=${graceUntil.toISOString()}, now=${now.toISOString()}. ` +
        `Wait until grace_until or use tenants.forceTerminate.`,
      options,
    );
    this.tenantId = tenantId;
    this.graceUntil = graceUntil;
    this.now = now;
    this.name = 'TenantGraceNotElapsedError';
  }
}

/**
 * Thrown by `tenants.rotateKeys` when a scheduled rotation arrives
 * within the 24-hour cooldown of the previous rotation AND the caller
 * opted in via `options.errorOnCooldown=true`. The default behavior
 * is silent no-op (per F02 Slice D §7.5 idempotency contract);
 * callers wanting an explicit signal use this option (typically the
 * Cloud Tasks worker route, which logs but does not retry).
 */
export class TenantRotationCooldownError extends TenantContextError {
  readonly tenantId: string;
  readonly lastRotatedAt: Date;
  readonly cooldownUntil: Date;

  constructor(
    tenantId: string,
    lastRotatedAt: Date,
    cooldownUntil: Date,
    options?: { cause?: Error },
  ) {
    super(
      'TENANT_ROTATION_COOLDOWN',
      `Tenant ${tenantId} key rotation in cooldown: ` +
        `last_rotated_at=${lastRotatedAt.toISOString()}, ` +
        `cooldown_until=${cooldownUntil.toISOString()}. ` +
        `Pass trigger='on_demand' to override or wait for the cooldown to elapse.`,
      options,
    );
    this.tenantId = tenantId;
    this.lastRotatedAt = lastRotatedAt;
    this.cooldownUntil = cooldownUntil;
    this.name = 'TenantRotationCooldownError';
  }
}

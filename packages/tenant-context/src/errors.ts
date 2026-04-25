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

/**
 * Public types for `@cortex/audit-events`.
 *
 * Two cross-cutting taxonomies:
 *   - `ActorType` — who emitted the event (matches migration 0008's CHECK)
 *   - `CrudVerb`  — the CRUD class of the action (compile-time discriminator)
 *
 * Plus a branded `AuditActionName` so registered catalog entries cannot
 * be confused with arbitrary strings, and the discriminated-union
 * `AuditEventParams` that callers pass to `emitAuditEvent` (sub-phase 4).
 *
 * Per ADR-AU-001 §Decision (action vocabulary — storage vs. type system):
 * the `name` lands in the `audit_event.action` column; the `verb` is a
 * type-system construct used for compile-time before/after enforcement.
 */

/**
 * Actor taxonomy per migration 0008's CHECK constraint:
 *   - 'service' — internal callers (foundation, audit, ingestion-gateway)
 *   - 'user'    — human-attributable (post-AC01)
 *   - 'system'  — process-attributable (cron, daemon, scheduled job)
 *   - 'agent'   — autonomous AI / MCP server / model decision
 */
export type ActorType = 'service' | 'user' | 'system' | 'agent';

/**
 * CRUD verb classes. Per ADR-AU-001 §Decision and planning-doc Decision 3,
 * each registered audit action declares its verb; the verb drives the
 * compile-time before/after-state contract in `AuditEventParams`.
 *
 * - CREATE          — `after_state` required, `before_state` forbidden
 * - READ            — both forbidden
 * - UPDATE          — both required (per spec SCR-20-FR-001)
 * - DELETE          — `before_state` required, `after_state` forbidden
 * - APPROVE/REJECT/EXECUTE — both optional (caller decides per use case)
 */
export type CrudVerb = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE' | 'APPROVE' | 'REJECT' | 'EXECUTE';

/**
 * Branded string for registered audit-action names. Callers cannot
 * construct an `AuditActionName` directly — they MUST funnel through
 * `registerAuditActions(...)` (sub-phase 5) which validates the name
 * against `AUDIT_ACTION_NAME_REGEX` and returns the brand.
 *
 * The brand is a TS-only construct (`& { __auditActionBrand?: never }`);
 * runtime values are plain strings and the brand erases at JS emit.
 */
export type AuditActionName = string & { readonly __auditActionBrand?: never };

/**
 * A registered audit-action entry: the `name` that lands in the
 * `audit_event.action` column plus the `verb` that drives compile-time
 * before/after enforcement. Generic over `V extends CrudVerb` so
 * consumers' typed registries narrow to specific verbs at the call
 * site.
 */
export interface AuditAction<V extends CrudVerb = CrudVerb> {
  readonly name: AuditActionName;
  readonly verb: V;
}

/**
 * Action-name regex per planning-doc Decision 4: `UPPER_SNAKE`,
 * optionally suffixed with verb tense (`_CREATED`, `_UPDATED`,
 * `_REMOVED`). Enforced at registration time by `registerAuditActions`;
 * exported here so downstream tooling (lint plugins, doc generators)
 * can mirror the constraint.
 */
export const AUDIT_ACTION_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Soft byte-size threshold for canonicalized payloads. The library logs
 * `WARN` when a serialized payload exceeds this size (per planning-doc
 * Decision 2 + roadmap §1.9); it does NOT throw. Threshold is a
 * heuristic; revisit when observed distribution surfaces a pattern.
 */
export const SOFT_PAYLOAD_LIMIT_BYTES = 64 * 1024;

/**
 * JSON-safe value: the only types permitted inside `payload` /
 * `before_state` / `after_state`. Recursive: arrays and objects nest
 * arbitrarily. Symbols, functions, undefined, BigInt, and Dates are
 * NOT JSON-safe and the schema layer (sub-phase 3) rejects them.
 *
 * Per ADR-DB-003 §3 caller contract, strings inside payload should be
 * Unicode NFC-normalized; the schema layer normalizes on parse.
 * Timestamps inside payload should be ISO-8601 UTC microsecond strings;
 * caller responsibility (the schema cannot heuristically detect
 * timestamp-shaped strings without false positives).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = Record<string, JsonValue>;

/**
 * Common fields on every audit event regardless of verb. Per spec
 * SCR-20-FR-001 + build prompt §P0.10. Stable columns on `audit_event`:
 * `tenantId`, `actorType`, `actorId`, `actorDescription`, action (via
 * `action.name`), `resource`. The remaining optional fields (`sessionId`,
 * `requestId`, `ipAddress`, `userAgent`, `workspaceId`) serialize into
 * `payload` until SCR-20 promotes them to first-class columns (planning
 * doc Decision 7, Risks §"Spec SCR-20-FR-001 fields not yet first-class
 * columns").
 *
 * `occurred_at` is intentionally NOT in this type — the library stamps
 * `clock_timestamp()` server-side on every INSERT (planning-doc
 * Decision 11, ADR-AU-001 §Rationale "Same-transaction insertions
 * require distinct `occurred_at` timestamps"). Convention doc
 * (sub-phase 8) instructs callers to omit the field.
 */
export interface AuditEventCommon {
  /** Tenant the event belongs to. UUID; library validates. */
  tenantId: string;

  /** Actor taxonomy — see `ActorType`. */
  actorType: ActorType;

  /**
   * Stable identifier for the actor — UUID for users, slug for service
   * accounts (e.g., `'foundation'`, `'audit'`, `'ingestion-gateway'`),
   * MCP-server name for agents.
   */
  actorId: string;

  /**
   * Optional free-text description for human context: email of the
   * acting user, version of the service, MCP-server pod id, etc.
   */
  actorDescription?: string;

  /**
   * Registered audit-action — must be obtained via
   * `registerAuditActions(...)` (sub-phase 5). The `verb` field
   * discriminates the per-verb param shape below.
   */
  action: AuditAction;

  /**
   * The resource the action targets — entity type + (optional)
   * identifier. Examples: `'tenant'`, `'tenant:01HYX...'`,
   * `'config_version:v3'`. Convention codified in sub-phase 8.
   */
  resource: string;

  /** Optional session identifier; serializes into payload. */
  sessionId?: string;

  /** Optional request correlation identifier; serializes into payload. */
  requestId?: string;

  /** Optional source IP; serializes into payload. */
  ipAddress?: string;

  /** Optional User-Agent header; serializes into payload. */
  userAgent?: string;

  /**
   * Optional workspace identifier (per spec SCR-20-FR-001). Stubbed
   * until the Workspace module lands; serializes into payload (planning
   * doc Decision 7).
   */
  workspaceId?: string;

  /**
   * Free-form payload bag for module-specific event detail. Strings
   * normalized to NFC by the schema layer; values must be JSON-safe.
   * Caller-supplied; merged with the optional/promoted fields above
   * when serialized to the `audit_event.payload` column.
   */
  payload?: JsonObject;
}

/**
 * Discriminated-union audit-event params. Discriminated on `verb`
 * (sourced from `action.verb` at the call site; the type system
 * narrows). Per planning-doc Decision 3 + ADR-AU-001 Decision.
 *
 * The `verb` field is duplicated at the top level (instead of
 * discriminating on `action.verb` directly) because zod's
 * `discriminatedUnion` requires a top-level literal discriminator
 * (see `schemas.ts`); the library's emit helpers (sub-phase 4) derive
 * `verb` from `action.verb` so callers don't pass it explicitly.
 *
 * `before_state?: never` makes the field a compile-time error to supply
 * under `exactOptionalPropertyTypes`. Same for `after_state`.
 */
export type AuditEventParams =
  | (AuditEventCommon & {
      verb: 'CREATE';
      before_state?: never;
      after_state: JsonObject;
    })
  | (AuditEventCommon & {
      verb: 'READ';
      before_state?: never;
      after_state?: never;
    })
  | (AuditEventCommon & {
      verb: 'UPDATE';
      before_state: JsonObject;
      after_state: JsonObject;
    })
  | (AuditEventCommon & {
      verb: 'DELETE';
      before_state: JsonObject;
      after_state?: never;
    })
  | (AuditEventCommon & {
      verb: 'APPROVE';
      before_state?: JsonObject;
      after_state?: JsonObject;
    })
  | (AuditEventCommon & {
      verb: 'REJECT';
      before_state?: JsonObject;
      after_state?: JsonObject;
    })
  | (AuditEventCommon & {
      verb: 'EXECUTE';
      before_state?: JsonObject;
      after_state?: JsonObject;
    });

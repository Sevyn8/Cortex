/**
 * Action-catalog registration for `@cortex/audit-events`.
 *
 * Per planning-doc Decision 4, each module declares its action
 * vocabulary as a closed set:
 *
 * ```ts
 * export const TENANT_AUDIT_ACTIONS = registerAuditActions([
 *   { name: 'TENANT_CREATED', verb: 'CREATE' },
 *   { name: 'TENANT_UPDATED', verb: 'UPDATE' },
 *   { name: 'TENANT_STATUS_CHANGED', verb: 'UPDATE' },
 *   { name: 'TENANT_CONFIG_VERSION_CREATED', verb: 'CREATE' },
 * ] as const);
 *
 * export type TenantAuditActionName = (typeof TENANT_AUDIT_ACTIONS)[number]['name'];
 * ```
 *
 * **Catalog ownership.** Each resource type's actions belong in
 * exactly one catalog, owned by the module responsible for that
 * resource. Cross-module audit needs are a code smell — surface them
 * as a roadmap entry, not as a runtime extension. There is no
 * `extend()` API; catalogs are closed sets declared once per module.
 *
 * **Name regex enforcement.** `registerAuditActions` throws
 * `AuditEventValidationError` at registration time for any name
 * failing `AUDIT_ACTION_NAME_REGEX` (`/^[A-Z][A-Z0-9_]*$/`). Caught
 * early — module load surface — rather than at emit time. Convention:
 * `UPPER_SNAKE`, optionally suffixed with verb tense (`_CREATED`,
 * `_UPDATED`, `_REMOVED`).
 *
 * **Duplicate detection.** Two entries with the same `name` (even with
 * different verbs) raise `AuditEventValidationError`. Prevents
 * accidental redeclaration during catalog growth.
 *
 * **Verb validation.** Defense-in-depth runtime check that the verb is
 * one of the seven `CrudVerb` literals — TS already enforces this at
 * the call site, but `as`-cast inputs would bypass; we check anyway.
 */

import { AuditEventValidationError } from './errors.js';
import { AUDIT_ACTION_NAME_REGEX, type AuditActionName, type CrudVerb } from './types.js';

const VALID_VERBS: ReadonlySet<CrudVerb> = new Set([
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'APPROVE',
  'REJECT',
  'EXECUTE',
]);

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Structural shape callers pass to `registerAuditActions`. Generic
 * parameters default to broad types so the descriptor is usable in
 * type positions without type args (`AuditActionDescriptor` ≡
 * `AuditActionDescriptor<string, CrudVerb>`).
 *
 * The `as const` (or TypeScript 5+ `const T extends ...` generic on
 * `registerAuditActions`) preserves literal types so consumers can
 * derive `(typeof CATALOG)[number]['name']` for a literal-union name
 * type.
 */
export interface AuditActionDescriptor<N extends string = string, V extends CrudVerb = CrudVerb> {
  readonly name: N;
  readonly verb: V;
}

// ─────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate and register a closed catalog of action descriptors.
 * Returns the input array unchanged so the caller's `as const` (or the
 * `const T` generic) preserves literal types for downstream type
 * derivations.
 *
 * Validates: name regex, verb membership, duplicate-name absence.
 *
 * @throws AuditEventValidationError — invalid name / verb / duplicate
 */
export function registerAuditActions<const T extends readonly AuditActionDescriptor[]>(
  actions: T,
): T {
  const seen = new Set<string>();
  for (const action of actions) {
    if (!AUDIT_ACTION_NAME_REGEX.test(action.name)) {
      throw new AuditEventValidationError(
        `Invalid action name '${action.name}'; must match ${AUDIT_ACTION_NAME_REGEX.source}`,
      );
    }
    if (!VALID_VERBS.has(action.verb)) {
      throw new AuditEventValidationError(
        `Invalid verb '${String(action.verb)}' for action '${action.name}'; ` +
          `must be one of CREATE|READ|UPDATE|DELETE|APPROVE|REJECT|EXECUTE`,
      );
    }
    if (seen.has(action.name)) {
      throw new AuditEventValidationError(`Duplicate action name in catalog: '${action.name}'`);
    }
    seen.add(action.name);
  }
  return actions;
}

// ─────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────

/**
 * Type-safe lookup. Given a registered catalog and a name (typed to
 * the catalog's literal-union of names), returns the matching
 * descriptor narrowed to that exact entry. The narrowing means the
 * returned `verb` is the specific verb declared for that name — useful
 * at the emit-time call site where the discriminated-union
 * `AuditEventParams` keys on the verb.
 *
 * Runtime check defends against `as`-cast inputs that bypass the type
 * system; throws `AuditEventValidationError` if the name isn't found.
 */
export function getActionByName<
  const T extends readonly AuditActionDescriptor[],
  N extends T[number]['name'],
>(catalog: T, name: N): Extract<T[number], { readonly name: N }> {
  for (const action of catalog) {
    if (action.name === name) {
      return action as Extract<T[number], { readonly name: N }>;
    }
  }
  throw new AuditEventValidationError(
    `Action '${name}' not in catalog (catalog has ${String(catalog.length)} entries)`,
  );
}

/**
 * Type guard. Narrows an arbitrary string to the catalog's literal
 * union of action names. Useful when an action name arrives from an
 * untrusted source (HTTP query parameter, message attribute) and the
 * caller wants to validate before threading into `getActionByName`.
 */
export function isRegisteredActionName<const T extends readonly AuditActionDescriptor[]>(
  catalog: T,
  name: string,
): name is T[number]['name'] & string {
  return catalog.some((action) => action.name === name);
}

// ─────────────────────────────────────────────────────────────────────
// Brand convenience
// ─────────────────────────────────────────────────────────────────────

/**
 * Cast a validated string to `AuditActionName`. Used internally; not
 * typically needed by consumers (the descriptor's `name` field is
 * already brand-compatible since `AuditActionName = string &
 * { __auditActionBrand?: never }` is satisfied by literal strings).
 *
 * Exported for the rare case where a consumer has independently
 * validated a name (e.g., from a config file) and wants to thread it
 * through APIs typed against `AuditActionName` without TS friction.
 */
export function asAuditActionName(name: string): AuditActionName {
  if (!AUDIT_ACTION_NAME_REGEX.test(name)) {
    throw new AuditEventValidationError(
      `Invalid action name '${name}'; must match ${AUDIT_ACTION_NAME_REGEX.source}`,
    );
  }
  return name as AuditActionName;
}

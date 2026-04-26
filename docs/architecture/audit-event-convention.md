# Audit event convention

Pattern reference for any module emitting compliance audit events to the
SHA-chained `audit_event` table via `@cortex/audit-events`. Read before
writing audit-emitting code in a new module.

Companion documents: ADR-AU-001 (library shape), ADR-DB-003 (chain
integrity), `docs/planning/p0-10-audit-events-scope.md` (decisions 1–11).

## When to emit audit events

Two-category model:

- **Compliance audit chain** — `@cortex/audit-events` library, lands in
  `audit_event` with the per-tenant SHA chain. Every mutating operation
  on tenant-scoped data, every sensitive read, every approval /
  rejection / execution decision. Spec SCR-20-FR-002 lists the canonical
  event types; SCR-20-FR-011 / O04-FR-009 / A07-FR-002 set retention
  (1 year warm + cold archival, or 7 years for decisions / actions).

- **Operational logging** — `@cortex/observability` logger, lands in
  Cloud Logging. Routine state transitions, performance traces, error
  reports. NOT chained, NOT in `audit_event`. Standard pino retention
  (~30 days warm).

When a module emits both for the same operation (e.g., a tenant create
logs the start, audits the result, logs the duration), the two are
independent — don't try to thread a correlation between the audit row
and the log line beyond the shared `correlation_id`.

## Module catalog ownership

Each module owns its action catalog. Tenant-lifecycle actions live in
`@cortex/tenant-context/src/audit-actions.ts`. Future modules declare
their own:

```typescript
import { registerAuditActions } from '@cortex/audit-events';

export const FOO_AUDIT_ACTIONS = registerAuditActions([
  { name: 'FOO_CREATED', verb: 'CREATE' },
  { name: 'FOO_DELETED', verb: 'DELETE' },
] as const);

export type FooAuditAction = (typeof FOO_AUDIT_ACTIONS)[number]['name'];
```

**Catalog ownership is exclusive.** Cross-module action sharing is a
code smell. If module B needs to emit an action declared in module A's
catalog, that's a sign the action belongs in a shared catalog or a new
module — surface as a roadmap entry rather than extending an existing
catalog. There is no `extend()` API by design.

**Naming convention.** `UPPER_SNAKE`, optionally suffixed with verb
tense — `_CREATED` / `_UPDATED` / `_REMOVED` / `_APPROVED` /
`_REJECTED`. Enforced by `AUDIT_ACTION_NAME_REGEX` at registration.
`AUDIT_ACTION_NAME_REGEX` is exported for downstream tooling
(lint plugins, doc generators).

## Verb mapping and state requirements

The library enforces these at compile time via the `AuditEventParams`
discriminated union:

| Verb    | `before_state` | `after_state` |
| ------- | -------------- | ------------- |
| CREATE  | forbidden      | required      |
| READ    | forbidden      | forbidden     |
| UPDATE  | required       | required      |
| DELETE  | required       | forbidden     |
| APPROVE | optional       | optional      |
| REJECT  | optional       | optional      |
| EXECUTE | optional       | optional      |

For UPDATE: emit the actual diff state — only the changed fields, not
the full row both sides. Inflates the chain otherwise. The
`@cortex/tenant-context` precedent in `tenants.ts` demonstrates this
(`displayName` only when it changed, both `before` and `after`
populated).

For DELETE: emit the soft-deletion source state for forensic recovery.
The downstream regulator query "what data did we hold for entity X
before deletion" needs the snapshot.

## TS API ↔ wire format

The library's TS API uses Node-convention camelCase; on the wire (in
`audit_event.payload` JSONB) the canonicalization layer maps to
snake_case:

```typescript
// TypeScript call site
await emitAuditEvent(tx, {
  tenantId,
  actorType,
  actorId,
  actorDescription,
  sessionId,
  requestId,
  ipAddress,
  userAgent,
  workspaceId,
  // ...
});
```

```jsonc
// audit_event.payload after canonicalization
{
  "session_id": "...",
  "request_id": "...",
  "ip_address": "...",
  "user_agent": "...",
  "workspace_id": "...",
  "before_state": {
    /* ... */
  },
  "after_state": {
    /* ... */
  },
  // user-supplied payload fields preserved as-is at top level
}
```

Operators reading audit logs via psql / BigQuery / Cloud Logging see
snake_case. Don't try to bridge the convention gap — the
canonicalization layer in `@cortex/audit-events/src/emit.ts` handles it.
SCR-20 dashboards and downstream analytics will key on the on-the-wire
names.

## Optional fields with `exactOptionalPropertyTypes`

The library's `actorDescription`, `sessionId`, `requestId`, etc. are
typed as `field?: string` under `exactOptionalPropertyTypes`. Direct
assignment of `undefined` is rejected; the field must be **omitted**.
Use conditional spread:

```typescript
await emitAuditEvent(tx, {
  tenantId,
  actorType,
  actorId,
  ...(actor.description !== undefined && { actorDescription: actor.description }),
  // ...
});
```

This pattern recurs in every F-series consumer that has optional
upstream-supplied actor metadata. Direct `actorDescription:
actor.description` (which TS infers as `string | undefined`) is a type
error.

## `occurred_at` — DO NOT supply

Per planning-doc Decision 11, the library auto-stamps
`occurred_at = clock_timestamp()` on every INSERT to prevent
same-transaction chain forks (sequential emits in one tx that share
`now()` / transaction-start time would tie on `occurred_at` and the
chain trigger's tail-lookup would select by UUID byte order, forking
the chain). The TS API doesn't expose the field — the type system
prevents misuse.

Backfill / late-record paths that need to set a specific `occurred_at`
go through SQL directly and bypass the library — out of scope for the
standard audit path. Coordinate with the chain integrity story
(ADR-DB-003) before adding such a path.

## Caller transactional contract

Every call to `emitAuditEvent` MUST:

1. Be inside an open transaction
   (`db.transaction(async (tx) => { ... })` or via a service-controller
   transaction context).
2. Have called `bindTenantToDbSession(tx, tenantId)` first to satisfy
   the `audit_event` RLS write policy.
3. Pass `tx` (not the bare `db` pool) so the audit row commits
   atomically with the source operation.

Without (2): the INSERT raises SQLSTATE `42501` and the library wraps
the pg error as `AuditEventEmissionError` with `cause.code === '42501'`
and a message that mentions "RLS" and "tenant binding".

Without (1): the row commits independently of the source op. If the
source op rolls back later, the audit row is orphaned — chain integrity
violated by construction. The library cannot detect this; reviewers
must.

## Module-load cycle gotcha

If your module imports `@cortex/audit-events` and you also need
`@cortex/observability` (e.g., for your own structured logging), do
**NOT** eagerly import observability at the same module-load level.
Doing so closes a load-order cycle:
`your-module → audit-events → observability → tenant-context → your-module`
(via tenant-context's transitive consumption).

Two safe patterns:

**(a) Get the logger from `@cortex/audit-events`.** The library handles
its own lazy resolution — `createAuditEventEmitter(opts)` accepts a
`Logger`, and the default emitter resolves observability via dynamic
import on first WARN. If you only need observability for your audit
emitter's logger, route through audit-events.

**(b) Type-only import + dynamic resolution.** The pattern in
`packages/audit-events/src/emit.ts`:

```typescript
import type { Logger } from '@cortex/observability';
// ... no eager runtime import ...

async function getLogger(): Promise<Logger> {
  const observability = (await import('@cortex/observability')) as {
    createLogger: (options: { moduleId: string }) => Logger;
  };
  return observability.createLogger({ moduleId: 'cortex-foo' });
}
```

Type-only imports are erased at compile time and never close the
cycle. The dynamic import resolves at first call, by which time all
packages are evaluated.

The proper architectural fix (decouple observability from
tenant-context entirely) is roadmap §4.13. Until that lands, the
patterns above are required for any new module that consumes
audit-events AND observability at the same call site.

## Common pitfalls

- **Don't pass `verb` and `action.verb` independently and let them
  drift.** The library compares them at runtime (zod validates
  `verb: z.literal('CREATE')` against the action object's verb under
  the discriminated union); mismatch throws `AuditEventValidationError`.
  Use `getActionByName(CATALOG, 'NAME')` and supply `verb` to match
  the catalog entry.
- **Don't `vi.mock` audit.ts directly if it has side effects at top
  level.** vi.mock factories run hoisted, before the mocked module's
  transitive workspace deps are initialized. If your audit module
  declares a catalog at top level (top-level `registerAuditActions(...)`
  call), the mock factory hits "registerAuditActions is not a function".
  Fix: split the catalog into a separate side-effect-free file (see
  `packages/tenant-context/src/audit-actions.ts` for the precedent;
  audit.ts is a pure re-export, audit-actions.ts holds the catalog).
- **Don't supply free-form timestamps inside payload.** The library
  canonicalizes strings (NFC) but doesn't auto-coerce timestamp
  formats. ADR-DB-003 §3 caller contract: timestamps in payload should
  be ISO-8601 UTC microsecond strings. Use `isoMicrosecondString` from
  `@cortex/audit-events` to validate caller-side.
- **Don't expect operational pino logs to land in `audit_event`.**
  They're separate; see "When to emit" above. If the regulator cares,
  it's compliance — chain it. Otherwise it's operational — log it.
- **Don't set `before_state` / `after_state` to `null` to mean
  "absent".** The discriminated union forbids them per verb (CREATE
  rejects `before_state`); supply only what the verb requires.

## Operational vs compliance — quick reference

```
Operational pino:  high volume, no chain, retained ~30 days
Compliance audit:  low volume, SHA chained, retained 7 years
```

If unsure whether something is operational or compliance: does the
regulator care? → compliance. Otherwise → operational. When in doubt,
chain it — overshoot is cheaper than undershoot.

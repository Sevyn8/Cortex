# P0.10: Audit event emission convention — Scope

**Status:** Scoping complete, implementation queued
**Scoped:** 2026-04-26
**Primary sources:** `docs/build-prompts/cortex_build_prompts_v3.md` §P0.10 (lines 886–923), Cortex v2.2 Spec §SCR-20-FR-001/-002/-009, F01 §1.5 audit references, ADR-DB-003
**Companion ADR:** ADR-AU-001 (audit events library — direct DB INSERT vs Pub/Sub fan-out)

---

## Context

P0.10 is the last Phase 0 prompt. It establishes the audit-event emission convention every subsequent module will honor. The substrate is already in place — migration `0004_audit_chain.sql` (per ADR-DB-003) ships the `audit_event` table, the per-tenant SHA-256 chain trigger, and append-only enforcement (`UPDATE`/`DELETE` raise `2F002`). What's missing is the cross-cutting library that wraps the contract for callers: typed action catalogs, payload canonicalization, hybrid-DI testability, and the convention doc that every F-series prompt will reference.

Two prerequisites unlocked the slot:

- **P0.4 Phase B (commit `4811821` substrate, migration 0004)** — `audit_event` table + `cortex.audit_canonical_hash()` + `cortex.audit_chain_trigger()` + RLS policies + append-only enforcement. The integrity foundation is fixed and verified.
- **P0.6 Phase 2 (commit `15e5574`)** — `@cortex/observability` is the structured-logger substrate the audit emitter uses for non-chain operational logging (DB-error reports, validation failures). `correlation_id` propagation via `withCorrelationContext` is the source of `payload.correlation_id` enrichment.

A working in-tree precedent exists in `packages/tenant-context/src/audit.ts` (F01 Slice A): zod-validated INSERT into `audit_event`, narrow `AuditAction` enum, transactional contract documented in JSDoc. P0.10 generalizes this pattern into `@cortex/audit-events` and migrates the F01 caller to consume the new library — single source of truth post-migration.

The build prompt's "Receives Pub/Sub topic audit.events" framing predates ADR-DB-003. Direct DB INSERT preserves transactional integrity with the source operation; Pub/Sub indirection forks the chain under retry. Resolved in ADR-AU-001 (companion).

## In scope

### Library: `/packages/audit-events`

`@cortex/audit-events` package with: typed `AuditEvent` schema (zod) covering the spec's 15-field shape (stable columns first-class, rest serialized into `payload jsonb`); `emitAuditEvent(db, params)` async function performing parameterized INSERT into `audit_event` inside the caller's transaction; payload canonicalization helpers (NFC string normalization, ISO-8601 µs timestamp coercion, integer-preferred number narrowing, JSON-safe value enforcement); `registerAuditActions(['ACTION_A', ...] as const)` helper for module-specific action catalogs producing branded `AuditAction` literals; hybrid-DI factory (`createAuditEventEmitter(opts)`) plus module-scope default plus `__setEmitterForTesting` / `__resetForTesting` escape hatches mirroring the secrets/bootstrap pattern; discriminated union on `action` so `UPDATE` requires `before_state` and `after_state` at compile time per spec SCR-20-FR-001.

### Substrate updates

- **Migration 0008** — extends `audit_event_actor_type_check` from `('service', 'user', 'system')` to `('service', 'user', 'system', 'agent')` per the build prompt's USER/SYSTEM/AGENT taxonomy. New `'agent'` value lands for MCP servers (P0.8), autonomous pipelines (A02+), and model-decision actors (A03+). Existing rows untouched; chain integrity preserved.
- **Drizzle schema entry** — adds `auditEvent` to `packages/canonical-schema/src/drizzle/schema.ts` so library helpers (and downstream consumers) can issue typed reads. Migration source-of-truth remains the SQL file; Drizzle entry is for app-side query typing only.

### F01 migration

`packages/tenant-context/src/audit.ts` retires its embedded zod schema and INSERT logic in favor of consuming `@cortex/audit-events`. The package's `AuditAction` enum becomes a `registerAuditActions([...] as const)` invocation co-located with the existing types module. F01 Slice A's audit-spec tests update mechanically; emitted-row shape and chain integrity unchanged.

### Documentation

- **ADR-AU-001** (companion to this scope doc) — direct DB INSERT vs Pub/Sub fan-out, with deferred-Pub/Sub pathway documented.
- **`docs/architecture/audit-event-convention.md`** — the rules every module follows: when to emit (mutating ops, sensitive reads, denial events), payload canonicalization contract (mirrored from CLAUDE.md), action-catalog declaration pattern, two-category model (durable DB-chained audits vs operational pino logs).
- **CLAUDE.md** — new "Audit events" subsection with the canonicalization rules and the convention reference. Existing "Database conventions" → "Canonical timestamps + hashing" cross-links.

## Deferred (explicitly out of scope)

Each entry below becomes a roadmap entry in sub-phase 9 of P0.10.

- **`verify_chain(tenant_id)` SQL function and library helper.** Per ADR-DB-003 Implementation Notes; SQL function shape documented but not implemented. Library helper waits on the SQL function. Trigger to revisit: first SCR-20 audit-service consumer needs verification, OR observed chain fork in production.
- **Concurrent-write fork prevention.** Advisory lock on `hashtextextended(tenant_id)`, dedicated `chain_tail` table, or partial unique index on `(tenant_id, prev_hash) WHERE prev_hash IS NOT NULL` — three solutions to the same problem, decided together when write-concurrency warrants. Per ADR-DB-003 Alternatives 3/4/5. Trigger: any tenant exceeds ~10/sec sustained audit writes, OR SCR-20 surfaces forks.
- **ESLint plugin `audit-on-mutation`.** Build prompt scopes a `@cortex/eslint-plugin-cortex` package with a rule that flags `@Mutating()`-decorated functions missing an `emitAuditEvent` call. Substantial separate deliverable (3–5 hr) with novel decorator-or-convention design questions; convention doc + code review carry the compliance load until first observed gap surfaces.
- **BigQuery Decision Log mirror (A07-FR-002 / A03-FR-004).** 7-year decision archive lands with A03 / A07 in Phase 1+. Schema + write path designed there; not P0.10 scope.
- **7-year retention enforcement (SCR-20-FR-011).** Cold-archival to GCS nearline / coldline lands with SCR-20 (Phase 5).
- **Signed audit exports (SCR-20-FR-010).** Per-tenant signing key, CSV / JSON Lines / signed PDF export, RBAC gate — SCR-20 territory (Phase 5).
- **Pub/Sub fan-out for downstream consumers.** Read-only LISTEN/NOTIFY or topic publication for analytics / SIEM integration — future ADR-AU-001 amendment when first non-DB consumer materializes.
- **Operational audit unification.** `secrets-audit` and `bootstrap-audit` (currently pino-logged via `@cortex/observability`) stay where they are. Different category — operational debug records, not durable compliance artifacts. Convention doc clarifies the two-category model rather than merging them.
- **`audit_event` indexes for SCR-22 elevated-review queries.** Spec SCR-20-FR-012 lists event categories that surface in SCR-22 (permission grants to high-privilege roles, cross-tenant access, consent withdrawals not followed by successful cascade, large export operations, audit-source disable events). Indexing strategy depends on the actual query shape, which lands with SCR-22 (Phase 2+). Migration 0008 deliberately ships only the CHECK extension; indexes design with actual query shape, not speculatively. Trigger: SCR-22 build prompt active. Roadmap §4.11.
- **Audit payload size hard enforcement.** Library logs WARN at 64 KB serialized payload (Decision 2); does not throw. Real enforcement (size cap, truncation, separate large-payload table) waits on observed distribution. Trigger: ongoing operator review surfaces a >64 KB rate that warrants action. Roadmap §1.9.

## Decisions

### Decision 1 — Substrate is direct DB INSERT into `audit_event`, NOT Pub/Sub

**Decision.** `emitAuditEvent(db, params)` performs a parameterized INSERT into `audit_event` inside the caller's transaction. The build prompt's "Receives Pub/Sub topic audit.events" framing is superseded; Pub/Sub fan-out for downstream consumers is deferred.

**Reasoning.** The `cortex.audit_chain_trigger` BEFORE INSERT trigger stamps `prev_hash` and `curr_hash` from the per-tenant chain tail at the moment of write. SHA chain integrity is therefore transactional with the source operation: if the source op rolls back, the audit row rolls back; the chain stays consistent. A Pub/Sub indirection layer publishes the event AFTER the source-op transaction commits — under retry, the same source op can produce two audit events, forking the chain (ADR-DB-003 Implementation Notes documents fork detection). Direct INSERT eliminates the failure mode entirely.

**Alternatives considered.** Pub/Sub-only (rejected — chain integrity); dual-write source-op-DB and Pub/Sub-fanout (rejected — coordination cost, dual-failure modes); direct INSERT now plus deferred LISTEN/NOTIFY for read-only fan-out when needed (this is the path).

**Authoritative source.** ADR-AU-001, ADR-DB-003 §Decision 4.

### Decision 2 — Library is the canonicalization boundary

**Decision.** `@cortex/audit-events` validates and canonicalizes every emit at the TS boundary. Zod schema enforces: NFC string normalization on all string-valued fields (including nested payload strings); ISO-8601 UTC microsecond strings for any timestamp inside payload; integer-preferred numbers (warn-on-float in payload via custom zod refinement); JSON-safe values only (`string | number | boolean | null | array | object`). Per-call validation; failure throws `AuditEventValidationError` with the zod issue chain attached.

**Reasoning.** ADR-DB-003 §3 documents a caller canonicalization contract — payload NFC, timestamps µs, integer-preferred — that the SQL hash function cannot enforce server-side without walking the payload. Today the contract is honored via JSDoc and code review only; the F01 audit emitter does no canonicalization. Library-level enforcement is the primary value-add over raw SQL: callers get a typed schema, get NFC and µs coercion for free, and the contract becomes mechanically verifiable in tests.

**Soft 64 KB payload cap.** When the canonicalized `payload` jsonb exceeds 64 KB on the wire, the library logs a `WARN` to `@cortex/observability` with `tenant_id` and `action_name` for forensic context. It does NOT throw. Reasoning: payload sizes exceeding 64 KB are usually large `before_state` / `after_state` snapshots for legitimate complex entities (tenant config blobs); rejecting would force callers to truncate-and-lose-fidelity, which is worse for compliance than a noisy log line. The 64 KB threshold is a heuristic; revisit when observed distribution surfaces a pattern (see roadmap §1.9). Convention doc (sub-phase 8) recommends caller-side pre-summarization for known-large payloads.

**Alternatives considered.** Server-side canonicalization in the trigger (rejected — too late; canonical form must match what callers can reproduce for verification); convention-only / no enforcement (rejected — observed drift on F01); hard payload-size cap with throw (rejected — see soft-cap reasoning above).

### Decision 3 — Discriminated union on `action` for before/after enforcement

**Decision.** The TS `AuditEvent` type is a discriminated union keyed on the CRUD verb derived from the action catalog. Constraints:

- `verb: 'CREATE'` — `after_state` required, `before_state` forbidden at compile time.
- `verb: 'UPDATE'` — both `before_state` and `after_state` required.
- `verb: 'DELETE'` — `before_state` required, `after_state` forbidden.
- `verb: 'READ'` — neither field present.
- `verb: 'APPROVE' | 'REJECT' | 'EXECUTE'` — both optional; caller decides per use case.

Each registered action declares its `verb` via the catalog helper (Decision 4); the discriminated union derives from that mapping.

**Reasoning.** Spec SCR-20-FR-001 mandates "before / after state where applicable"; build prompt §P0.10 makes "before_state and after_state required for UPDATE actions" explicit. Enforcing this at the type boundary pushes the requirement into IDE feedback rather than runtime errors or review catches. Compile-time guarantees per spec mandate, with no runtime cost.

**Alternatives considered.** Runtime-only zod refinement (rejected — pushes the error to runtime, weakens the spec mandate); free-form fields with documentation (rejected — historical data shows convention drift without enforcement).

### Decision 4 — Module action catalog via `registerAuditActions` helper

**Decision.** Each module declares its action vocabulary via:

```ts
export const TENANT_AUDIT_ACTIONS = registerAuditActions([
  { name: 'TENANT_CREATED', verb: 'CREATE' },
  { name: 'TENANT_UPDATED', verb: 'UPDATE' },
  { name: 'TENANT_STATUS_CHANGED', verb: 'UPDATE' },
  { name: 'TENANT_CONFIG_VERSION_CREATED', verb: 'CREATE' },
] as const);
```

The library accepts `action: AuditActionName` where `AuditActionName` is a branded string type. `registerAuditActions(...)` returns a typed registry; consumers derive their literal-union action type from the registry (e.g., `(typeof TENANT_AUDIT_ACTIONS)[number]['name']`). The branding prevents bare-string actions; callers must funnel through a registered catalog.

**Reasoning.** Build prompt scopes "typed event catalogs per module (each module declares its event types)". F01's `AuditAction = 'TENANT_CREATED' | ...` literal union is the precedent. Branding plus registration gives stronger guarantees than literal-union extension via declaration merging — callers cannot accidentally emit a typo like `'TENANT_UDPATED'`. Each catalog also declares the CRUD verb for Decision 3's discriminated union; the registry is the single source of action-to-verb mapping.

**Storage vs. type-system split.** The `action` column in `audit_event` (migration 0004) stores the registered `name` only. The `verb` lives in the library's type registry and is used for the discriminated-union before/after enforcement (Decision 3). It is NOT denormalized into the table. Verb-based queries (e.g., "all UPDATE-class events for tenant X") are expressed for now via a `CASE` over the registered catalog at query time. Promoting `action_verb` to a first-class column is deferred until SCR-22 elevated-review queries (per SCR-20-FR-012) surface a real pattern; see roadmap §4.11. This resolution preserves F01's storage contract (the existing `action` column already holds names like `TENANT_UPDATED`) while keeping the build prompt's CRUD-verb discriminated union intact at the type boundary.

**Catalog ownership.** Each resource type's actions belong in exactly one catalog, owned by the module responsible for that resource. Cross-module audit needs are a code smell — surface them as a roadmap entry, not as a runtime extension. There is no `extend()` API on the registry; catalogs are closed sets declared once per module. The convention doc (sub-phase 8) codifies this rule.

**Name regex enforced at registration.** `registerAuditActions(...)` throws `AuditEventValidationError` if any `name` fails `/^[A-Z][A-Z0-9_]*$/`. The regex is exported as `AUDIT_ACTION_NAME_REGEX` for downstream tooling (lint plugins, doc generators). Convention: `UPPER_SNAKE`, optionally suffixed with verb tense (`_CREATED`, `_UPDATED`, `_REMOVED`). Enforcement at registration (not at emit) catches drift early; production calls then have a fast-path validated brand.

**Alternatives considered.** Literal-union extension via TypeScript declaration merging (rejected — easy for consumers to forget the merge import; weaker discoverability); free-form `action: string` (rejected — typos drift; build prompt mandates typed catalogs); naming convention only `MODULE.RESOURCE.VERB` parsed at runtime (rejected — runtime parsing tax, no compile-time guarantee); cross-module catalog `extend()` API (rejected — invites coupling that masks resource-ownership smells).

### Decision 5 — Hybrid DI mirroring secrets / bootstrap pattern

**Decision.** Library exports:

- `createAuditEventEmitter(opts)` factory returning an `AuditEventEmitter` interface with `.emit(db, params)`.
- Module-scope default emitter backing the convenience `emitAuditEvent(db, params)` export — same shape consumers already use in F01.
- `__setEmitterForTesting(emitter)` and `__resetForTesting()` escape hatches.

**Reasoning.** Established convention. `@cortex/observability` (`__setLoggerForTesting`), `@cortex/secrets/audit` (`__setLoggerForTesting`), `@cortex/bootstrap` (`__setLoggerForTesting`), and `@cortex/tenant-context/correlation-context` (`__getContextStoreForTesting`) all use this hybrid shape: factory for new code, module-scope singleton for backward-compat with existing callers, test-only escape hatch for swap-in-test. Adopting the same pattern in `@cortex/audit-events` keeps the workspace ergonomics consistent — five packages now, F-series modules will inherit the muscle memory.

### Decision 6 — `actor_type` extends to `('service', 'user', 'system', 'agent')`

**Decision.** Migration 0008 amends the `audit_event_actor_type_check` constraint:

```sql
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_type_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_actor_type_check
  CHECK (actor_type IN ('service', 'user', 'system', 'agent'));
```

The library's zod schema accepts the four values. Existing rows are untouched; chain integrity unaffected (no historical event has `actor_type='agent'`, so no historical hash recomputes).

**Reasoning.** Build prompt's actor taxonomy is `USER/SYSTEM/AGENT`. The `'service'` value already in 0004 covers internal service actors (foundation, audit, ingestion-gateway). `'agent'` is distinct: autonomous decision-making actors — MCP servers (P0.8), pipeline orchestrators (A02), model-decision emitters (A03). The distinction matters for compliance review (SCR-22 elevated-review filters per SCR-20-FR-012 may want to highlight agent-driven actions differently from service-driven ones). Adding the value before any consumer emits is cheaper than adding it later when production data exists.

### Decision 7 — `workspace_id` field stubbed in payload

**Decision.** `AuditEvent.workspace_id` is an optional field on the typed schema. When supplied, it serializes into `payload.workspace_id` (no first-class column). When absent, no key in payload.

**Reasoning.** Spec SCR-20-FR-001 lists "workspace" as an audit field. Workspace as a concept doesn't yet exist (lands later, no module ID assigned in current build prompts). Stubbing it in payload keeps the typed surface forward-compatible: future Workspace module promotes payload key to a first-class column with a migration; library API doesn't change. Consumers can populate it today (or omit) without a library version bump.

### Decision 8 — `verify_chain` helper and ESLint plugin DEFERRED

**Decision.** `verify_chain(tenantId)` library helper and the `@cortex/eslint-plugin-cortex` audit-on-mutation rule are out of P0.10 scope. Both become roadmap entries in sub-phase 9.

**Reasoning.** Verify-chain depends on a SQL function (`cortex.verify_audit_chain`) that ADR-DB-003 explicitly defers — shape documented but not implemented; lands when SCR-20 audit service needs it. The library cannot productively wrap a function that doesn't exist; adding a stub that always returns "not implemented" is noise. ESLint plugin is a substantive 3–5 hour deliverable with novel decorator-vs-convention design questions; F01 Slices B/C ship without it. Convention doc + code review carry the compliance load through Phase 1; lint is added when first observed gap surfaces in F-series review.

### Decision 9 — `tenant-context/src/audit.ts` migrates INTO `@cortex/audit-events`

**Decision.** F01 Slice A's `packages/tenant-context/src/audit.ts` retires its embedded zod schema, INSERT logic, and `AuditAction` enum. Replacement: `tenant-context/src/audit.ts` becomes a thin adapter that calls into `@cortex/audit-events`. The action vocabulary moves to `tenant-context/src/audit-actions.ts` (or similar) declared via `registerAuditActions([...] as const)`. F01 callers using `emitAuditEvent(db, params)` see no API surface change.

**Reasoning.** F01 wrote the precedent in good faith pre-`@cortex/audit-events`; the migration retires the duplication. Single source of truth for emit logic, zod schema, canonicalization — both packages benefit. Test surgery is mechanical: F01's audit-spec tests assert on observable behavior (audit row inserted, chain incremented, RLS enforced) which the new library implements identically.

### Decision 10 — Operational audits (`secrets-audit`, `bootstrap-audit`) NOT migrated

**Decision.** `@cortex/secrets/audit` and `@cortex/bootstrap`'s `emitAuditLog` continue to emit pino structured logs via `@cortex/observability`. They are NOT migrated to `@cortex/audit-events`. Two-category model documented in the convention doc.

**Reasoning.** The two emitters serve different purposes:

- **Operational audits** (current pino path): high-cardinality debug-flavored records — Secret Manager `get`/`put`/`encrypt`/`decrypt` operations, bootstrap admin creation attempts. These flow through Cloud Logging for ad-hoc operator search; they may have `tenant_id: null` (the secrets KMS path is system-level) or pre-tenant context (bootstrap creates the first admin). They are operational signals, not durable compliance artifacts.
- **Compliance audits** (the new path): tamper-evident records with tenant attribution and SHA-chain integrity — every authentication event, configuration change, decision emission, consent state change, etc. (per SCR-20-FR-002). These flow through `audit_event` with chain enforcement.

Forcing operational audits through the chain inflates the chain with low-signal records and conflates two consumer audiences. The convention doc clarifies the split so future modules know which category their emissions belong in.

### Decision 11 — Library auto-stamps `occurred_at` with `clock_timestamp()`

**Decision.** The library injects `occurred_at = clock_timestamp()` into every INSERT, regardless of caller intent. Callers SHOULD NOT supply `occurred_at`; if they do, the library overwrites it with `clock_timestamp()` to guarantee strict ordering of audit events emitted within a single transaction.

**Reasoning.** Sub-phase 2's chain-integrity probe surfaced a chain-fork failure mode broader than ADR-DB-003's "concurrent-write race" framing: same-transaction sequential INSERTs share `now()` (transaction-start time, constant within a txn). The chain trigger's tail-lookup `ORDER BY occurred_at DESC, event_id DESC` ties on equal `occurred_at` and falls back to UUID byte order — which is NOT insertion order. Result: two sequential audit emissions in one transaction can produce a chain fork (both events compute the same `prev_hash`).

`clock_timestamp()` returns the actual wall-clock time at the moment of the function call, distinct for each INSERT within a transaction. Strict ordering of insertions within a txn is restored.

**Caller contract.** Callers MAY pass `occurred_at` for documentation purposes, but the library will overwrite it. Convention doc (sub-phase 8) recommends omitting the field entirely.

**Alternatives considered.** Hard-contract one-event-per-transaction (rejected — limits batch emission patterns; e.g., a single API call mutating multiple resources can legitimately emit multiple audits); accept fork risk for batches and document (rejected — silent landmine for future authors); caller-supplied microsecond timestamps (rejected — same drift risk as caller canonicalization, which is exactly what Decision 2 establishes the library should solve).

**References.** ADR-AU-001 §Rationale, ADR-DB-003 Implementation Notes (existing concurrent-write framing — same-txn case is a broader case of the same trigger), sub-phase 2 chain probe output.

## Sub-phases

P0.10 is the first prompt of its scope; numbering uses "Sub-phase N" rather than "Phase N" to avoid colliding with P0.6's prior phase numbering (Phase 1 / Phase 2 / Phase 3).

| #   | Title                                                         | Estimate | Description                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Planning doc + ADR-AU-001                                     | 1 hr     | This sub-phase. Lands `docs/planning/p0-10-audit-events-scope.md` + `docs/architecture/decisions/ADR-AU-001-audit-events-library-shape.md`.                                                                                                                                                                                         |
| 2   | Migration 0008 (`actor_type` adds `'agent'`) + Drizzle entry  | 1 hr     | Single-purpose migration: extends `audit_event_actor_type_check` to include `'agent'`. NO indexes added; index design deferred to SCR-22 when the actual query shape is known (see deferred list, roadmap §4.11). Drizzle `auditEvent` table mapping in `packages/canonical-schema/src/drizzle/schema.ts`. Apply against p09-repro. |
| 3   | Package scaffold + types + errors + zod schemas               | 1.5 hr   | `@cortex/audit-events` package. `errors.ts` with `AuditEventError` hierarchy, `types.ts` with action-name brand + `AuditEvent` discriminated union, zod schemas with NFC + µs coercion refinements.                                                                                                                                 |
| 4   | Core emit function + hybrid DI + canonicalization             | 2 hr     | `createAuditEventEmitter` factory, module-scope default, `emitAuditEvent` convenience export, `__setEmitterForTesting` / `__resetForTesting`, payload canonicalization helpers.                                                                                                                                                     |
| 5   | Action catalog helper + index barrel                          | 1 hr     | `registerAuditActions([...] as const)` helper with verb mapping, branded types, registry export. Public barrel.                                                                                                                                                                                                                     |
| 6   | Tests (unit + integration)                                    | 2 hr     | Unit tests with mocked db; integration tests against p09-repro exercising real chain, RLS enforcement, append-only, multi-tenant isolation. ~25–35 tests.                                                                                                                                                                           |
| 7   | `tenant-context/src/audit.ts` migrates to consume the library | 1 hr     | F01 audit emitter becomes a thin wrapper. Action vocabulary declared via `registerAuditActions`. F01 audit-spec tests update mechanically.                                                                                                                                                                                          |
| 8   | Convention doc + CLAUDE.md update                             | 1 hr     | `docs/architecture/audit-event-convention.md` (when-to-emit, two-category model, payload contract). CLAUDE.md "Audit events" subsection.                                                                                                                                                                                            |
| 9   | Final aggregate + commit + roadmap backfill                   | 1 hr     | Full workspace test pass. Commit + push. Roadmap backfill: §4.2 marked resolved; §1.7 / §1.8 / §4.10 cross-references; new entries for the deferrals (verify_chain, fork-prevention, ESLint plugin, BigQuery, retention, signed exports, Pub/Sub fan-out).                                                                          |

Total: ~10–12 hours.

## Risks & mitigations

- **Concurrent-write race fork.** ADR-DB-003 documents this; library doesn't fix it. Mitigation: convention doc explicitly notes per-tenant write concurrency must be coordinated by the caller (e.g., advisory lock or single-writer pattern for high-write tenants); fork detection lands with `verify_chain` later. The library itself is not the right layer to solve the race — it's a DB-level concurrency question. Trigger to revisit per ADR-DB-003: any tenant exceeds ~10/sec sustained.
- **Action-catalog drift.** Module catalogs declared independently can drift in naming convention (`TENANT_CREATED` vs `tenant.created` vs `tenant_created`). Mitigation: the convention doc establishes a canonical pattern (UPPER*SNAKE for action names, verb-suffixed where natural — `<RESOURCE>*<VERB_PAST_TENSE>`); first F-series consumers establish the precedent; future audit-event-convention doc revisions can codify a regex if drift becomes real.
- **F01 migration breakage.** `@cortex/tenant-context/audit.ts` rewriting risks unobserved behavior change. Mitigation: F01's existing 8 audit-spec tests run unchanged before and after migration; integration tests (real DB chain) validate row shape, hash chain, RLS. If any test changes, that's a behavior change worth catching at review.
- **`AuditAction` brand interop.** Branded types can't be passed across module boundaries that don't share the brand declaration. Mitigation: `@cortex/audit-events` is the single source of the brand; all consumers import from it; brand becomes a no-op at runtime (it's a TS-only construct), so the runtime API surface is just `string`.
- **Migration 0008 + chain integrity.** Adding `'agent'` to the CHECK doesn't recompute existing hashes (CHECK is a constraint, not a hashed field), but the migration must verify zero existing rows fail the new constraint (vacuously true today — only F01 Slice A audits exist, all `'service'` or `'system'`). Mitigation: integration test in sub-phase 2 inserts one row of each new type and asserts no chain breakage.
- **Two-category confusion.** Future F-service authors may not know which category their emission belongs in. Mitigation: convention doc has a decision-tree heuristic — "is this a tenant-attributed compliance record?" (chain) vs "is this an operational debug record?" (pino). When in doubt: chain.
- **Spec SCR-20-FR-001 fields not yet first-class columns.** `session_id`, `ip_address`, `user_agent`, `workspace_id` live in payload until SCR-20 promotes them. Mitigation: typed schema accepts them as top-level optional fields; canonicalization layer serializes into payload transparently. Future column promotion is a migration + a payload-key-removal in the same step; library API stays stable.
- **Payload-size drift.** Without a hard cap, callers can attach arbitrarily large `before_state` / `after_state` snapshots — bloating `audit_event` rows and Cloud Logging costs. Mitigation: 64 KB soft signal (WARN log per Decision 2), convention doc recommends pre-summarization, roadmap §1.9 captures the eventual hard-cap design once observed distribution surfaces a pattern.

## References

- **ADR-DB-003** — Audit Event SHA Chain (substrate; the reason this library is thin)
- **ADR-AU-001** — Audit events library shape (companion; direct DB INSERT vs Pub/Sub)
- **ADR-OBS-001** §Decision 5 — substrate-level redaction (informs payload-canonicalization stance)
- **ADR-SEQ-001** — Phase 0 tail sequencing (P0.10 last; gates F01 Slices B/C)
- **Build prompt §P0.10** (`docs/build-prompts/cortex_build_prompts_v3.md` lines 886–923)
- **Cortex v2.2 Spec §SCR-20** — Audit & Activity Log (FR-001 through FR-012; FR-009 = SHA chain mandate)
- **Cortex v2.2 Spec §AC01** — Audit Layer (every authorization decision logged)
- **Cortex v2.2 Spec §A03-FR-004 / §A07-FR-002** — Decision audit trail / Decision Log (BigQuery; out of P0.10 scope)
- **Cortex v2.2 Spec §O04-FR-009** — Action Audit Log (out of P0.10 scope)
- **Cortex v2.2 Spec §F01-FR-001** — every operation carries `tenant_id` (the source of audit context)
- **Migration `services/foundation/migrations/0004_audit_chain.sql`** — substrate (table + chain trigger + RLS)
- **`packages/tenant-context/src/audit.ts`** — F01 Slice A precedent (pre-library)
- **`packages/secrets/src/audit.ts` / `scripts/bootstrap/lib/bootstrap.ts`** — Category-A operational audit emitters (NOT migrated)
- **CLAUDE.md** — "Database conventions" → "Canonical timestamps + hashing"; "Append-only tables"; new "Audit events" subsection (sub-phase 8)

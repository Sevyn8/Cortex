# ADR-AU-001: Audit events library — direct DB INSERT vs Pub/Sub fan-out

**Status:** Accepted
**Date:** April 2026
**Deciders:** Amit (Sevyn8 engineering)
**Context documents:** `docs/build-prompts/cortex_build_prompts_v3.md` §P0.10 (lines 886–923), Cortex v2.2 Spec §SCR-20-FR-009, ADR-DB-003 (audit-event SHA chain), `docs/planning/p0-10-audit-events-scope.md`
**Companion decisions:** ADR-DB-003 (substrate), ADR-OBS-001 (logger boundary)

---

## Context

Migration 0004 lands the `audit_event` table with a per-tenant SHA-256 chain stamped by a BEFORE INSERT trigger and append-only enforcement on UPDATE/DELETE (`2F002`). The chain integrity model is fixed: each event's `curr_hash` includes the prior event's `curr_hash` for the same tenant; chain verification (when implemented) detects any mutation or fork.

P0.10 ships `@cortex/audit-events` — the cross-cutting library that every mutating service method will call. The build prompt's text reads:

> emit() function — structured, signed (per SCR-20-FR-009 SHA-chain) — Receives Pub/Sub topic audit.events

Two competing models in that single line: the SHA chain (database-side, transactional) and a Pub/Sub topic (out-of-band, async). They are not the same shape and we have to commit to one before consumers fan out.

The competing models:

1. **Direct DB INSERT.** Caller's transaction wraps both the source operation and the audit emission. The chain trigger stamps `prev_hash` and `curr_hash` from the live tail at INSERT time. Commit semantics: if the source op rolls back, the audit row rolls back; the chain stays consistent.

2. **Pub/Sub-only.** Caller publishes an event message to a topic; a downstream subscriber consumes the topic and writes to `audit_event`. The source operation commits independently of the audit publication; an audit consumer reads the topic and inserts into the table.

3. **Dual-write.** Caller does both — publishes to Pub/Sub AND inserts directly. Either path can be the chain authority; the other is fan-out.

The build prompt was written before ADR-DB-003 nailed the chain shape; since then, F01 Slice A's `packages/tenant-context/src/audit.ts` has been emitting via direct INSERT for ~3 weeks across 8 audit-spec tests with no chain breakage. The trigger-based chain assumes a specific shape (transactional, sequential per tenant) that Pub/Sub indirection does not preserve under retry.

This decision picks one model and documents the deferred path for the others.

## Decision

**`@cortex/audit-events` performs direct DB INSERT into `audit_event` inside the caller's transaction.** Pub/Sub fan-out is deferred to a future amendment when the first non-DB consumer (analytics, SIEM, real-time alerting) materializes.

Specifically:

- The library's `emitAuditEvent(db, params)` function (and the factory-returned `emitter.emit(db, params)`) takes a `NodePgDatabase` (or transaction-scoped `tx` from `db.transaction(async (tx) => ...)`) and runs a parameterized INSERT.
- The caller is responsible for: (a) opening the transaction, (b) binding `tenant_id` to the DB session via `bindTenantToDbSession` from `@cortex/tenant-context` so RLS authorizes the INSERT, (c) ensuring the source operation and the audit emission share the same transaction so they commit or roll back atomically.
- The library does NOT publish to Pub/Sub. No `@google-cloud/pubsub` dependency in the package.
- Future fan-out path: a Postgres LISTEN/NOTIFY trigger or a logical-decoding consumer (Debezium-style) reads from `audit_event` and republishes to Pub/Sub for analytics consumers. This is read-only; it does not write to `audit_event` and therefore cannot fork the chain.

**Action vocabulary — storage vs. type system.** Each emit accepts an `action` value validated against a registered catalog (`@cortex/audit-events`'s `registerAuditActions(...)`, sibling planning doc Decision 4). Only the catalog `name` lands in the `action` column of `audit_event`; the library's TypeScript discriminated union derives the `verb` (CRUD class — `CREATE`/`READ`/`UPDATE`/`DELETE`/`APPROVE`/`REJECT`/`EXECUTE`) from the registry side at compile time. Verb-based queries (e.g., "all UPDATE events for tenant X") are expressed via a `CASE` over the registered catalog at query time, until SCR-22 elevated-review queries (per spec SCR-20-FR-012) surface a pattern that justifies promoting `action_verb` to a first-class column. The verb / name split lets domain-action ergonomics from F01's precedent (`TENANT_UPDATED`) coexist with the build prompt's CRUD-verb discriminated union without doubling the column count or breaking F01's existing storage contract.

## Rationale

**Chain integrity is transactional with the source operation.** SCR-20-FR-009 mandates SHA-chain integrity. The chain trigger reads the prior tail under the same MVCC snapshot as the new INSERT; the per-tenant chain head advances atomically. If the source op rolls back, the audit row's reservation rolls back too, and the next emission for the same tenant reads the unrolled-back tail — the chain remains intact. A Pub/Sub indirection breaks this: the source op commits, then publishes; the publish can fail or be retried, producing zero events (chain skip) or two events (chain fork). The chain trigger has no way to deduplicate a republished message; both INSERTs would compute their own `prev_hash` from whatever the live tail was at THEIR INSERT time, producing two events with potentially the same `prev_hash` (fork) or different `prev_hash` values from a moving tail (skip).

**Same-transaction insertions require distinct `occurred_at` timestamps.** The chain trigger's tail-lookup orders by `(occurred_at DESC, event_id DESC)`. Within a single transaction, `now()` is constant (= transaction-start time), so multiple INSERTs sharing the column default tie on `occurred_at` and fall back to UUID byte order for tail selection — which is not insertion order. The result is a chain fork even in the absence of any cross-transaction concurrency. The library mitigates by stamping `clock_timestamp()` on every INSERT (planning doc Decision 11). ADR-DB-003's "concurrent-write race" framing is correct but narrower than the failure surface; the same-txn case is the immediate one this library must address.

**Latency and failure modes favor direct INSERT.** Direct INSERT cost: one INSERT into a table with a BEFORE INSERT trigger, ~1ms. Pub/Sub publish: 10–50ms typical, with retry semantics under publisher-side failures. For 1:1 audit-per-source-op emission (the current pattern), direct INSERT is faster and has fewer failure modes. Pub/Sub becomes attractive when fan-out factor is N>1 (one event, many consumers) — which is exactly when the deferred LISTEN/NOTIFY path picks up.

**Working precedent.** `packages/tenant-context/src/audit.ts` ships F01 Slice A's audit emission via direct INSERT (8 audit-spec tests, real chain, real RLS, real append-only). The precedent works; P0.10 generalizes it.

**Cost of getting this wrong is high.** Once consumers fan out (F01 Slices B/C, then AC01, then F02–F05), changing the substrate is a coordinated migration across every emit site. Locking in direct INSERT now, with a documented amendment path for Pub/Sub fan-out later, is cheaper than locking in Pub/Sub now and unwinding it under chain-integrity pressure.

## Consequences

### Positive

- Chain integrity is preserved transactionally with no library-level coordination.
- Library has zero infrastructure dependencies beyond Postgres — no Pub/Sub topic provisioning, no subscriber, no DLQ.
- Failure modes are simple: source op fails → audit fails (correct); audit fails → source op rolls back (correct).
- Working F01 precedent migrates cleanly. No mental-model shift for consumers.
- Future fan-out via LISTEN/NOTIFY or logical decoding is read-only; cannot fork the chain by construction.

### Negative

- **Tight coupling between source op and audit emission.** Caller must thread the transaction. If a service splits its transaction (rare; a code smell), audit emission and source op decouple. Mitigation: convention doc requires single-transaction; lint check could enforce later.
- **No async fan-out by default.** Real-time analytics or SIEM consumers cannot subscribe today. Mitigation: deferred LISTEN/NOTIFY path (read-only, fork-safe). Trigger to revisit: first consumer demands real-time fan-out.
- **DB-write contention scales with audit volume.** Every audit hits the same `audit_event` table with the same per-tenant chain head. Pub/Sub would amortize via async write. Mitigation: chain contention is per-tenant, not global (per-tenant scope via the trigger's `WHERE tenant_id = NEW.tenant_id`); a noisy tenant doesn't affect others. Per-tenant fork-prevention is already a known revisit (ADR-DB-003 Implementation Notes); same trigger.
- **Verb-based queries cost a `CASE` expression.** Queries of the form "find all UPDATE-class events for tenant X" express as `WHERE CASE action WHEN 'TENANT_UPDATED' THEN 'UPDATE' WHEN ... END = 'UPDATE'` — joining the registry-side mapping at query time. Acceptable until SCR-22's actual query pattern is known; promotes to a first-class `action_verb` column when warranted (deferred per planning doc roadmap §4.11).
- **Caller-supplied `occurred_at` is silently overwritten.** A caller that passes a specific timestamp expecting it to land in the column will instead see `clock_timestamp()`. Mitigation: convention doc (sub-phase 8) instructs callers to omit the field; type system also accepts but documents the overwrite.

### Neutral

- Library API matches what F01's tenant-context audit emitter already exposes (`emitAuditEvent(db, params)`). No surprise migration cost.
- Pub/Sub deferred path is a future ADR amendment, not a code change waiting to happen.

## Alternatives considered

### A. Pub/Sub-only

Caller publishes to `audit.events` topic; subscriber writes to `audit_event`. **Rejected.** Source-op commit and audit publish are independently retryable; under retry, the chain forks. The chain trigger has no idempotency key beyond `event_id` (UUID, freshly generated per call) and can't deduplicate a republished message. Chain verification would surface forks as integrity failures even when the underlying operations were correct. Acceptable only if we're willing to drop SHA-chain integrity, which spec SCR-20-FR-009 does not permit.

### B. Dual-write (Pub/Sub + direct INSERT)

Caller does both; one is the chain authority, the other is fan-out. **Rejected.** Two-phase coordination cost: if direct INSERT succeeds and Pub/Sub publish fails, retry the publish (idempotency: dedup on `event_id`). If publish succeeds and INSERT fails (transaction rollback), the topic has a phantom event the chain doesn't reflect. Either failure mode adds operational complexity without buying integrity. Pub/Sub publish should be downstream of (not parallel with) the chain.

### C. LISTEN/NOTIFY for read-only fan-out (deferred)

Trigger on `audit_event` INSERT publishes a NOTIFY; downstream consumers `LISTEN audit_events_inserted` and read the new row by `event_id`. **Deferred to future amendment.** Read-only, so it cannot fork the chain. Useful when first analytics / SIEM consumer materializes. Trigger to revisit: first non-DB consumer demands real-time fan-out, OR audit-volume pressure on Cloud Logging-via-pino reaches operational pain point.

### D. Logical-decoding consumer (Debezium / `pgoutput`)

A separate process subscribes to Postgres logical replication, watches `audit_event` INSERTs, and republishes to Pub/Sub or any sink. **Deferred.** Same fan-out semantics as Option C with stronger ordering guarantees and replication-lag visibility, at the cost of a separate operational substrate (replication slots, consumer process, DLQ). Trigger to revisit: same as Option C, but preferred when the consumer is heavyweight (analytics warehouse load) rather than lightweight (alert routing).

## References

- **ADR-DB-003** — Audit Event SHA Chain. The substrate this decision wraps.
- **`docs/planning/p0-10-audit-events-scope.md`** — sibling planning doc, includes Decision 1 mirror plus the broader P0.10 scope.
- **Cortex v2.2 Spec §SCR-20-FR-009** — SHA-chain integrity mandate.
- **`docs/build-prompts/cortex_build_prompts_v3.md` §P0.10** — original Pub/Sub-flavored framing, superseded here.
- **`packages/tenant-context/src/audit.ts`** — F01 Slice A precedent for direct INSERT (working in production-equivalent tests since commit `4811821`).
- **`services/foundation/migrations/0004_audit_chain.sql`** — substrate migration (table, trigger, RLS, append-only).
- **CLAUDE.md** — "Database conventions" → "Canonical timestamps + hashing"; "Append-only tables".

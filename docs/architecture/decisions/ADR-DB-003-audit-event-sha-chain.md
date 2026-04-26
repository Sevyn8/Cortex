# ADR-DB-003: Audit Event SHA Chain

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Context documents:** Cortex v2.2 Spec §SCR-20-FR-009 Audit Log integrity, §F01 §1.5 Audit Trail; P0.4 build prompt (v3.1)
**Companion decisions:** ADR-INFRA-005 (Cloud SQL posture), ADR-DB-001 (bi-temporal), ADR-DB-002 (RLS contract)

---

## Context

SCR-20-FR-009 requires the audit log to be **tamper-evident**: a subsequent actor with database access cannot delete or modify past audit events without detection. The standard mechanism is a hash chain — each event's hash incorporates the prior event's hash, so any mutation breaks the chain downstream.

Phase B locks in the chain shape (per-tenant, SHA-256, canonical JSON), the append-only enforcement, and the table schema. The table and its trigger become the integrity substrate every mutating service method emits events into (CLAUDE.md §"Audit events": "Every mutating service method emits an audit event via `@cortex/audit-events`" — the package itself is scoped to a later prompt; Phase B provides the database substrate it will write to).

Phase B deliberately defers several audit-chain concerns; these are captured under Implementation Notes with revisit triggers:

- Concurrent-write protection (advisory lock or chain_tail table).
- `verify_chain(tenant_id)` function.
- Per-tenant sequence column.
- Named genesis row.

Per prior-session Decision 10 + this morning's per-tenant chaining approval, the scope below is the minimum viable integrity substrate — detection via verification is left to when the audit service (SCR-20) needs it; prevention of forks at write time is accepted as a known Phase B limitation.

## Decision

**`audit_event` table with structured actor triple, canonical-JSON per-event hash, per-tenant SHA-256 chain, `BEFORE INSERT` trigger that computes and stamps the chain, append-only enforcement via `BEFORE UPDATE OR DELETE` trigger that raises.**

Specifically:

1. **Table schema.**

   ```sql
   CREATE TABLE audit_event (
     event_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id         uuid        NOT NULL,
     actor_type        text        NOT NULL CHECK (actor_type IN ('service', 'user', 'system')),
     actor_id          text        NOT NULL,
     actor_description text,
     action            text        NOT NULL,
     resource          text        NOT NULL,
     payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
     occurred_at       timestamptz NOT NULL DEFAULT now(),
     prev_hash         bytea,                       -- NULL for genesis row of a tenant's chain
     curr_hash         bytea       NOT NULL,        -- stamped by BEFORE INSERT trigger
     inserted_at       timestamptz NOT NULL DEFAULT now()
   );

   CREATE INDEX audit_event_tenant_time ON audit_event (tenant_id, occurred_at DESC, event_id);
   ```

   - No bi-temporal columns on this table. Audit events are immutable facts about when something _happened_; valid-time and txn-time collapse to `occurred_at`. ADR-DB-001's SCD trigger is deliberately **not** attached.
   - `inserted_at` is separate from `occurred_at` — the former is DB clock (tamper-resistant), the latter is caller-supplied (business-meaningful). Divergence between them is a signal; verification tooling can flag events where `|inserted_at − occurred_at| > threshold`.

2. **Structured actor triple: `actor_type`, `actor_id`, `actor_description`.**
   - `actor_type` constrained by CHECK to `service` / `user` / `system`. Extensions are ADR-worthy.
   - `actor_id` is text (not uuid) to accommodate service identifiers (`foundation`, `audit`, `ingestion-gateway`) alongside user uuids (`550e8400-...`).
   - `actor_description` optional free-text for human context (email, service version, pod id).
   - Queryability: "all actions by service actors on resource X in tenant Y" is a straight `WHERE` clause, no string parsing.

3. **Canonical hash function `cortex.audit_canonical_hash`.**

   ```sql
   CREATE FUNCTION cortex.audit_canonical_hash(
     p_event_id          uuid,
     p_tenant_id         uuid,
     p_actor_type        text,
     p_actor_id          text,
     p_actor_description text,
     p_action            text,
     p_resource          text,
     p_payload           jsonb,
     p_occurred_at       timestamptz
   ) RETURNS bytea
     LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
     SELECT sha256(convert_to(jsonb_build_object(
       'event_id',          p_event_id::text,
       'tenant_id',         p_tenant_id::text,
       'actor_type',        p_actor_type,
       'actor_id',          p_actor_id,
       'actor_description', p_actor_description,
       'action',            p_action,
       'resource',          p_resource,
       'payload',           p_payload,
       'occurred_at',       to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
     )::text, 'UTF8'));
   $$;
   ```

   - Hashes **all stable fields**, not just `payload`. A mutation to `actor_id`, `action`, or `resource` must also break the chain, not only payload mutations.
   - `jsonb::text` relies on Postgres 17's deterministic key ordering within `jsonb` (keys sorted by length then bytewise at storage time). Stable across Postgres 17 minor versions; tested in Phase B acceptance.
   - `occurred_at` is normalized to UTC ISO-8601 with microsecond precision. The cast `AT TIME ZONE 'UTC'` fixes the offset regardless of `timezone` GUC.
   - **Caller canonicalization contract** (documented in migration comment, repeated in CLAUDE.md §"Audit events"):
     - `payload` must contain only JSON-safe values (strings, numbers, booleans, nulls, arrays, objects).
     - Timestamps inside `payload` must be ISO-8601 UTC strings with microsecond precision (the hash function cannot enforce this without walking the payload; callers are responsible).
     - String values in `payload` must be Unicode NFC-normalized. Hash function does not re-normalize; callers with user-supplied text must normalize at ingestion.
     - Numbers should be integers where precision matters. Floats are allowed but hash-sensitive to serialization (JavaScript → JSON vs. Postgres `numeric` can differ in trailing zeros).
   - `IMMUTABLE PARALLEL SAFE` SQL — inlines at plan time, usable in indexes if future verification needs them.

4. **Per-tenant SHA chain via `BEFORE INSERT` trigger `cortex.audit_chain_trigger`.**

   ```sql
   CREATE FUNCTION cortex.audit_chain_trigger() RETURNS trigger
     LANGUAGE plpgsql AS $$
   DECLARE
     v_prev bytea;
   BEGIN
     IF TG_OP = 'INSERT' THEN
       SELECT curr_hash INTO v_prev
         FROM audit_event
         WHERE tenant_id = NEW.tenant_id
         ORDER BY occurred_at DESC, event_id DESC
         LIMIT 1;
       NEW.prev_hash := v_prev;  -- NULL for genesis row of this tenant's chain
       NEW.curr_hash := sha256(
         COALESCE(NEW.prev_hash, '\x'::bytea) ||
         cortex.audit_canonical_hash(
           NEW.event_id, NEW.tenant_id, NEW.actor_type, NEW.actor_id, NEW.actor_description,
           NEW.action, NEW.resource, NEW.payload, NEW.occurred_at
         )
       );
       RETURN NEW;
     END IF;
     RAISE EXCEPTION 'audit_event is append-only (attempted %)', TG_OP
       USING ERRCODE = '2F002';  -- modifying_sql_data_not_permitted
   END;
   $$;

   CREATE TRIGGER audit_chain
     BEFORE INSERT OR UPDATE OR DELETE ON audit_event
     FOR EACH ROW EXECUTE FUNCTION cortex.audit_chain_trigger();
   ```

   - Per-tenant scope via `WHERE tenant_id = NEW.tenant_id` in the prev-hash lookup.
   - Genesis row has `prev_hash = NULL`; the `COALESCE(NEW.prev_hash, '\x'::bytea)` ensures the hash input is deterministic (empty bytea prefix) rather than NULL-propagating.
   - Append-only enforcement lives in the same trigger function. `UPDATE` or `DELETE` on `audit_event` raises SQLSTATE `2F002` (`modifying_sql_data_not_permitted`).
   - Trigger is `BEFORE`, so it can rewrite `NEW.prev_hash` and `NEW.curr_hash` before the row reaches storage. Services pass `prev_hash` / `curr_hash` as `NULL`-or-ignored; the trigger is the single writer.

5. **RLS policies.**
   - `audit_event` enables RLS and applies the DB-002 templates:
     ```sql
     ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
     -- tenant_read_policy and tenant_write_policy per ADR-DB-002.
     ```
   - A future `admin_read_policy` for the audit service (SCR-20, cross-tenant read for platform admins) is anticipated but explicitly out of Phase B scope — see ADR-DB-002 §4 for the deferred admin-bypass shape.

## Rationale

- **Per-tenant chain over global chain.** A single global chain gives a single immutable ledger — cryptographically strong. But: (a) verification is O(all events) rather than O(events in tenant), making the audit service slow on multi-tenant data; (b) a RLS breach or cross-tenant fork would mix chains across tenants, making detection harder; (c) per-tenant chains fail-closed on tenant isolation (the chain is itself tenant-scoped, so a leak of tenant A's chain tail doesn't taint tenant B's). Per-tenant is the right trade for Cortex's multi-tenant posture.
- **Structured actor triple over free-form.** `WHERE actor_type = 'service'` beats `WHERE actor LIKE 'service:%'` on every dimension — index selectivity, query ergonomics, constraint enforcement. The CHECK constraint catches "actor_type = 'users'" typos before they ossify.
- **Hash all stable fields, not just payload.** A chain that only protects `payload` lets an attacker with DB write access mutate `actor_id` / `action` / `resource` without breaking the chain. Hashing the full row (minus `prev_hash` / `curr_hash` / `inserted_at`) means any mutation to any meaningful field is detectable.
- **`jsonb::text` as canonical form.** Postgres 17 stores jsonb with keys sorted by length then bytewise; `jsonb::text` emits in that order. Stable across 17.x, portable to any 17 instance. Implementing a separate RFC 8785 canonicalizer in PL/pgSQL is possible but adds maintenance surface for marginal correctness gain — jsonb's ordering is already deterministic.
- **`occurred_at` normalized to UTC ISO-8601 microseconds.** Strings serialize identically across clients; timezones don't leak into hashes; microsecond precision matches Postgres's native timestamptz resolution.
- **`inserted_at` separate from `occurred_at`.** Callers control `occurred_at` (business truth); DB controls `inserted_at` (tamper-resistant clock). A divergence between them flags backfills, clock skew, or malicious replay.
- **Append-only in the same trigger as chain insertion.** One function, one trigger, two code paths based on `TG_OP`. Keeps the audit-integrity logic co-located; `BEFORE INSERT OR UPDATE OR DELETE` is a single `CREATE TRIGGER` statement.

## Consequences

### Positive

- Chain integrity is enforced at the DB layer — services cannot bypass by constructing rows directly.
- Per-tenant chains verify in O(events per tenant), not O(total events).
- Actor queries are first-class (indexable, constrainable, non-parsed).
- Append-only is a hard wall: `UPDATE audit_event SET action = ...` raises, regardless of caller.

### Negative

- **Phase B accepts the concurrent-write race.** Two concurrent inserts for the same tenant, both reading the same prev_hash, both committing, produce a **fork** in the chain — two events with the same `prev_hash`, neither referencing the other. Chain verification (when built) will detect this, but prevention is deferred. Acceptable for Phase B's write volume (services don't yet exist); revisit trigger below.
- Caller canonicalization contract is work for every caller. `@cortex/audit-events` (scoped to later prompt) will wrap this; Phase B's direct writers must honor it manually.
- Non-trivial payload schema evolution will change hashes for logically equivalent events. A payload like `{"new_field": null}` hashes differently from `{}`. Accepted — audit events are point-in-time records, not schema-migrated entities.

### Neutral

- `audit_event` is tenant-scoped but **not** bi-temporal. SCD trigger not attached; events are immutable by design.

## Alternatives considered

1. **Global chain (one head across all tenants).** Rejected — fails-open under cross-tenant fork, O(total events) verify, operationally awkward under multi-tenant RLS.
2. **Free-form `actor` column (`text`).** Rejected — queryability suffers; every consumer re-implements "parse actor into type + id" logic.
3. **Advisory lock on `hashtextextended(tenant_id)` in the trigger.** Rejected for Phase B — adds contention on high-write tenants, complexity for negligible benefit at Phase B write volume. Revisit when write concurrency warrants.
4. **Separate `audit_chain_tail` table with UPDATE-on-insert.** Rejected for Phase B — eliminates the race but introduces a second transactional object, more migration surface, more failure modes. Keep the simple form until write pressure forces the change.
5. **Partial unique index `(tenant_id, prev_hash) WHERE prev_hash IS NOT NULL`.** Would prevent forks via OCC (unique-violation on concurrent commit; services retry). Tempting — cheap to add, catches the race without locks. **Rejected for Phase B** per prior-session Decision 10 deferral instruction; revisit alongside the advisory-lock / chain-tail decision when write concurrency warrants, since all three solutions address the same problem and should be chosen together.
6. **Hash only `payload`, leave other columns outside the chain.** Rejected — leaves `actor_id` / `action` / `resource` tamper-able without chain break.
7. **RFC 8785 (JSON Canonicalization Scheme) for payload.** Rejected for Phase B — Postgres's `jsonb::text` ordering is deterministic within 17.x; RFC 8785's stricter guarantees (number canonicalization, escape canonicalization) matter more for cross-language interop than for our single-Postgres substrate. Promote to RFC 8785 if cross-system chain verification ever becomes a use case.
8. **Per-tenant sequence column (`seq bigint GENERATED …`).** Rejected for Phase B — adds the same concurrency problem as the prev_hash lookup (who owns seq N+1?). `occurred_at DESC, event_id DESC` ordering is sufficient for Phase B's single-index lookup. Revisit with advisory-lock / chain-tail.
9. **Named genesis row (a sentinel with `prev_hash = 0x0...`).** Rejected for Phase B — `NULL prev_hash` is semantically identical and requires zero provisioning. Named genesis makes sense if verification needs an explicit anchor; add then.

## Implementation notes

- **Concurrent-write race accepted.** Two audits for the same tenant committing in overlapping transactions can fork the chain. Verification (when built) detects; prevention is Phase-B-deferred. Revisit trigger: when any tenant's audit write rate exceeds ~10/sec sustained, OR when SCR-20 ships and verification surfaces forks.
- **Same-transaction sequential INSERTs (broader case of the fork failure).** The "concurrent-write race" framing above describes two transactions racing for the chain tail. A broader failure case exists: two sequential INSERTs within a single transaction sharing `now()` as their `occurred_at` default value. The trigger's tail-lookup `ORDER BY occurred_at DESC, event_id DESC` ties on `occurred_at` and selects by UUID byte order — not insertion order — producing a fork. Both same-txn and cross-txn forks share the same root cause (chain-tail ambiguity under timestamp ties) and the same eventual mitigation paths (per-tenant advisory lock, partial unique index on `(tenant_id, prev_hash)`, sequence column). The `@cortex/audit-events` library (P0.10) addresses the same-txn case immediately by stamping `clock_timestamp()` on every INSERT (per ADR-AU-001 §Rationale + planning doc Decision 11). Cross-transaction races remain on the same revisit trigger as before. Reference: planning doc Decision 11, ADR-AU-001 §Rationale.
- **`verify_chain(tenant_id uuid)` deferred.** Shape when added:
  ```sql
  -- Future: cortex.verify_audit_chain(p_tenant_id uuid)
  --   RETURNS TABLE (broken_at uuid, expected_hash bytea, actual_hash bytea)
  -- Walks the chain from genesis (prev_hash IS NULL) through tail by following
  -- (tenant_id, prev_hash → curr_hash) links. For each event, recomputes
  --   sha256(COALESCE(prev_hash, '\x') || audit_canonical_hash(...)).
  -- Yields rows where the recomputed hash differs from curr_hash, or where
  -- the chain has a fork (two events sharing a prev_hash). Empty result = chain valid.
  -- Not implemented in Phase B; added when SCR-20 audit service needs it.
  ```
- **Per-tenant sequence column deferred.** `seq bigint` under advisory lock / chain-tail pattern. Revisit trigger: same as concurrent-write above.
- **Named genesis row deferred.** `NULL prev_hash` convention is Phase B's anchor. If verification tooling wants an explicit genesis sentinel, add a `cortex.create_tenant_audit_genesis(tenant_id)` function at tenant-provisioning time.
- **pgcrypto dependency.** `sha256()` and `gen_random_uuid()` are provided by `pgcrypto`, enabled in `0001_extensions.sql`.
- **`inserted_at` explicitly excluded from canonical hash.** The hash covers caller-supplied fields (`actor_type`, `actor_id`, `actor_description`, `action`, `resource`, `payload`, `occurred_at`) — what the caller claims happened. `inserted_at` is the DB server-clock stamp (when the row actually landed in storage). Keeping `inserted_at` outside the chain is intentional: (a) callers don't control it, so including it would prevent clients from reproducing the hash for verification; (b) `|inserted_at − occurred_at|` divergence is itself a forensic signal (backfills, clock skew, replay attacks) — a non-hashed field that can be compared against hash-covered `occurred_at` gives us a cross-check the chain alone doesn't provide.
- **CLAUDE.md needs an "Audit events" canonicalization subsection.** Phase B's docs pass (commit 4 in the task list) adds: payload must be NFC-normalized, timestamps ISO-8601 UTC microseconds, integers preferred over floats. Cross-ref to this ADR.
- **Phase B acceptance test (`services/foundation/test/audit-chain.spec.ts`):**
  1. Insert genesis event for tenant A → `prev_hash = NULL`, `curr_hash` is `sha256('\x' || canonical)`.
  2. Insert second event for tenant A → `prev_hash = first.curr_hash`, `curr_hash` is new.
  3. Insert genesis event for tenant B → `prev_hash = NULL` (independent chain).
  4. Attempt `UPDATE audit_event SET action = 'tampered' WHERE event_id = ...` → raises SQLSTATE `2F002`.
  5. Attempt `DELETE FROM audit_event WHERE ...` → raises SQLSTATE `2F002`.
  6. Recompute `curr_hash` manually in test code; assert equality with stored value → validates canonical serialization is deterministic and matches caller expectation.

### Observation — `timestamptz` round-trips lose microsecond precision via JS Date (P0.4 Phase B discovery)

Postgres `timestamptz` has microsecond precision; the default `pg` driver type parser converts fetched values to JS `Date`, which has millisecond precision and silently drops three decimal digits. Sending the Date back as `$N::timestamptz` reconstructs it with zero-padded microseconds — a different canonical string, a different hash output.

The Phase B audit-chain reproducibility test hit this: reading `occurred_at` into a Date, then passing it back to `cortex.audit_canonical_hash` produced a different curr_hash than what the trigger originally stored. The trigger, the canonical-hash function, and the test's equality assertion are individually correct; the precision loss is entirely client-side, invisible without comparing byte-exact hashes.

**Rule:** hash / signature computations over timestamps must be done entirely server-side. If a client-side computation is ever unavoidable, configure a string-preserving pg type parser that returns ISO-8601 µs strings rather than JS Dates.

```sql
-- Server-side recomputation pattern (no client round-trip):
SELECT sha256(
         COALESCE(prev_hash, '\x'::bytea) ||
         cortex.audit_canonical_hash(
           event_id, tenant_id, actor_type, actor_id, actor_description,
           action, resource, payload, occurred_at
         )
       )
FROM audit_event WHERE ...;
```

Cross-ref: CLAUDE.md "Database conventions" → "Canonical timestamps + hashing".

### Observation — TRUNCATE bypasses the audit_chain append-only trigger (P0.4 Phase B discovery)

`audit_chain` attaches as `BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW` — fires on row-level DML. Postgres `TRUNCATE` is a statement-level operation that fires only `BEFORE TRUNCATE` triggers (if any); it does NOT fire per-row triggers. The append-only `2F002` raise in the trigger body is therefore bypassed when a role with TRUNCATE privilege runs `TRUNCATE audit_event`.

This is Postgres convention, not a bug. Phase B accepts it: production service roles do not hold TRUNCATE privilege on `audit_event` — reaching TRUNCATE requires an out-of-band admin role. Dev test setup deliberately uses TRUNCATE for idempotent fixture clearing between test runs, which the append-only trigger cannot block.

**If absolute end-to-end append-only is ever required,** add a statement-level BEFORE TRUNCATE trigger:

```sql
CREATE FUNCTION cortex.audit_reject_truncate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (attempted TRUNCATE)'
    USING ERRCODE = '2F002';
END;
$$;

CREATE TRIGGER audit_chain_truncate_guard
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION cortex.audit_reject_truncate();
```

Cross-ref: CLAUDE.md "Database conventions" → "Append-only tables".

## References

- Cortex v2.2 Spec §SCR-20-FR-009 Audit Log tamper-evidence — the requirement.
- Cortex v2.2 Spec §F01 §1.5 Audit Trail — upstream audit event emission convention.
- `docs/architecture/audit-event-convention.md` — CLAUDE.md-referenced convention for what constitutes an auditable action.
- PostgreSQL docs, `pgcrypto` — https://www.postgresql.org/docs/17/pgcrypto.html
- PostgreSQL docs, JSON / JSONB storage and ordering — https://www.postgresql.org/docs/17/datatype-json.html
- RFC 8785 JSON Canonicalization Scheme — https://datatracker.ietf.org/doc/html/rfc8785 (considered, deferred; see Alternatives §7).
- ADR-DB-002 — RLS policies applied to `audit_event`.

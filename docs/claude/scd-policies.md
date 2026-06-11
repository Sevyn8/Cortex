# SCD policies (F03 Slice C)

> Relocated from CLAUDE.md for context-budget; loaded on demand.

`@cortex/temporal-query` ships the SCD-policy schema; `cortex.cortex_scd_trigger()` (migrations 0016/0017) reads policy from F04's `tenant_config_version` namespace `tenant.scd` and dispatches by per-entity-type config. Default-when-absent = SCD Type 2 (mandatory backward compat per Q-NEW-F03C-4).

### The 5 SCD types

| Type  | Semantic                                      | UPDATE behavior                                                                                 | DELETE behavior                                             |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **1** | Overwrite (no history)                        | In-place; row id stable                                                                         | Physical delete                                             |
| **2** | Row rotation (canonical bi-temporal default)  | Close OLD txn_time; INSERT NEW with rotated id                                                  | Logical close (row stays; txn_time upper set)               |
| **3** | Previous value in sibling column              | In-place; capture OLD's `<previousValueColumn>` to NEW's `<col>_previous` sibling               | Physical delete (Type 3 isn't history-preserving on delete) |
| **4** | Separate history table                        | Caller's UPDATE in-place; OLD INSERTed into history table                                       | Physical delete from main; OLD INSERTed into history        |
| **6** | Hybrid (Type 2 + per-column previous capture) | Type 2 row rotation PLUS per-column `<col>_previous` capture for cols in `previousValueColumns` | Type 2 logical close (no per-column capture on delete)      |

### `tenant.scd` namespace + hardcoded Type 2 fallback

Per Q-NEW-F03C-2 lock: SCD policies live in F04's `tenant.scd` namespace. **No `platform.scd`** — F04's substrate is per-tenant only (D14 ships `platform → tenant` resolution but both tiers are per-tenant rows; no cross-tenant slot exists for a platform-default row). The trigger's hardcoded Type 2 default IS the cross-tenant default.

**Forward-compat exit criterion:** if future F04 substrate work adds NULL-`tenant_id` support OR a separate `platform_config` table + RLS carve-out, the trigger's hardcoded Type 2 fallback can be replaced with a DB-driven default lookup. Slice C's trigger keeps the default-path isolated and replaceable for that future work.

### "Trigger trusts validated JSONB" anti-pattern

The trigger does NOT re-validate JSONB shape on every UPDATE/DELETE. Zod validation runs at promote-time via F04 lifecycle (`promoteDraft` defensively re-validates per Q-NEW-F04B-6). Once promoted, the JSONB in `tenant_config_version` is trusted — the trigger reads `entity_policy ->> 'type'` directly without re-checking shape.

**Anti-pattern:** bypassing F04 lifecycle to mutate `tenant_config_version` directly via raw SQL. The trigger will read whatever's there and may dispatch to a malformed code path. **Always go through `createDraft → validateDraft → promoteDraft` for SCD policy changes.**

### `EXCEPTION WHEN insufficient_privilege` catch (test-fixture tolerance)

The trigger's policy lookup queries `tenant_config_version` which is RLS-bound (`FOR ALL tenant_id = current_tenant_id()`). Callers without `app.tenant_id` bound (e.g., test fixtures running raw INSERT/UPDATE/DELETE without `withTenantContext`) would otherwise hit SQLSTATE 42501 from `cortex.current_tenant_id()`. The trigger wraps the policy lookup in `BEGIN/EXCEPTION WHEN insufficient_privilege` → `policy_json := NULL` → Type 2 default fallback.

**Production callers ALREADY bind tenant context** via `bindTenantToDbSession()` before any UPDATE/DELETE on bi-temporal tables (RLS would fail-closed otherwise). The exception path is a test-fixture accommodation, NOT a production code path. Future maintainers reading the trigger should see WHY this catch exists, not have to reconstruct reasoning.

### Schema-version mutation rule

Per Q-NEW-F03C-7e: schema versions registered via `registerNamespaceSchema(namespace, schema, { version })` **can be mutated in-place when no production drafts pin to them**. Bump the version only when (a) active drafts exist that would invalidate against the new shape, OR (b) the change would invalidate registered consumers. Slice C C.3's tightening of Types 3/4/6 from placeholder to locked shapes was an in-place v=1 mutation — safe because zero production drafts currently pin to v=1.

This rule applies workspace-wide; F04's `registerNamespaceSchema` precedent (`@cortex/config-plane/src/schema-registry.ts`) governs the registry, but the mutation policy is owned at the slice-author level.

### Caller responsibilities (per-Type DDL)

The trigger raises clean errors when caller-managed DDL is missing:

- **Type 3** requires sibling `<previousValueColumn>_previous` column on the table. Trigger raises if missing.
- **Type 4** requires the history table (`<historyTableName>` or default `<TG_TABLE_NAME>_history`) to exist. Trigger raises if missing.
- **Type 6** requires sibling `<col>_previous` column for EACH entry in `previousValueColumns`. Trigger raises if any sibling missing.

Caller-managed = consumer's migration creates the sibling columns / history table BEFORE promoting the policy. Future enhancement (out of Slice C scope; tracked in slice scope doc): F04 `validateDraft` hook to check `information_schema.tables` + `information_schema.columns` at promote-time.

### Future-notes

- **Type 7 (multi-column previous-value-only)** — canonical SCD has 5 types (1, 2, 3, 4, 6); Type 5 is a deprecated label. A hypothetical Type 7 = multi-column previous-value capture WITHOUT row rotation (Type 3 across multiple columns). Ship if a first consumer needs multi-column previous-value tracking without row history (currently Type 6 covers this case but couples to row rotation). First-consumer-driven per ADR-DB-001 deferral pattern.
- **F04 `validateDraft` Type 4 history-table existence check** — cross-module enhancement; would let promote fail-fast at lifecycle-time instead of trigger raising at first UPDATE. Implementation: F03 Slice C registers a validate-hook with `@cortex/config-plane`; hook is called from `validateDraft` for `tenant.scd` namespace drafts.
- **Cross-tenant DB-driven default** — F04 substrate work to support NULL `tenant_id` + RLS carve-out, OR a separate `platform_config` table. Would replace the trigger's hardcoded Type 2 fallback with a DB-driven default. Tracked in slice scope doc as forward-compat exit criterion.

**Cross-refs:**

- `docs/planning/f03-slice-C-scope.md` (Slice C scope; Q-NEW-F03C-1-7 locks)
- `docs/planning/f03-temporal-data-engine-scope.md` (F03 module scope; multi-phase close timeline)
- `services/foundation/migrations/0016_f03_scd_policy_aware_trigger.sql` (trigger rewrite — Types 1/2 + stubs)
- `services/foundation/migrations/0017_f03_scd_types_3_4_6.sql` (full Types 3/4/6 implementations)
- `packages/temporal-query/src/scd-policy.ts` (Zod schema + namespace registration)
- `services/foundation/test/scd-policy-trigger.spec.ts` (16 per-type behavior tests + F04 lifecycle integration)

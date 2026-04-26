# ADR-INFRA-007: Per-tenant CMEK migration path

**Status:** Accepted
**Date:** 2026-04-26
**Deciders:** Amit (Sevyn8 engineering)
**Context documents:** `docs/build-prompts/cortex_build_prompts_v3.md` §P1.1 (lines 933–996), Cortex v2.2 Spec §F01-FR-004, ADR-INFRA-004 (CMEK key hierarchy), `docs/planning/f01-slice-b-encryption-blob-isolation-scope.md`
**Companion decisions:** ADR-INFRA-004 (env-level keys), ADR-AU-001 (audit emission), ADR-DB-002 (RLS — `tenant_kms_key` is RLS-protected)

---

## Context

ADR-INFRA-004 established the env-level CMEK keyring posture for Phase 1: each env (`sevyn8-cortex-{dev,staging,prod}`) hosts a `cortex-keyring` containing `cortex-cloudsql-key`, `cortex-gcs-key`, `cortex-pubsub-key`, `cortex-secrets-key`, and `cortex-general-key`. Per-tenant keys were deferred to Phase 2+ on the rationale that Phase 1 has one tenant; the operational and billing overhead of per-tenant key management does not earn its keep until tenant count grows or a DPA / compliance requirement explicitly demands per-tenant key material.

Slice A (commit `4811821`) shipped the `tenant_kms_key` control-plane table (migration 0007) — a substrate row mapping each tenant to its bound KMS key resource name — but did NOT ship an INSERT path. The table is empty today.

`@cortex/secrets/src/per-tenant-keys.ts` ships `getKeyForTenant(tenantId)` as a Phase-1 stub: it UUID-validates the input, ignores it, and returns `buildKeyResourceName('cortex-general-key')`. Comment in the file explicitly delegates the swap to F02. Roadmap §7.1 tracks the stub's lifecycle as Open until F02 ships real per-tenant keys.

F01 build prompt §1.2.4 requires "per-tenant CMEK via /packages/secrets" and "transparent envelope encryption for PII-classified columns". Slice B (this slice) ships `@cortex/encryption` consuming `@cortex/secrets.envelope.encrypt/decrypt`, which uses `cortex-general-key` as KEK and binds `tenantId` into AEAD AAD via `setAAD(Buffer.from(tenantId, 'utf8'))` (verified in `packages/secrets/src/kms.ts:96`). Cross-tenant decryption fails at the auth-tag layer regardless of which key the resolver returns — so AAD-bound envelopes are the actual cryptographic isolation primitive in Phase 1, with the env-shared key acting only as the key-encryption-key.

Slice B's gap: the `tenant_kms_key` table sits empty and the encryption library cannot consult it productively when every row would point at the same env key anyway. We need to bridge: ship the INSERT path NOW so every tenant has a row from creation onward, keep the row pointing at the env key for Phase 1, and lock the migration shape so F02's swap is purely additive (no envelope-format change, no data re-encryption).

Without this ADR, F02 inherits an ambiguous handoff: was the empty table intentional (waiting for F02) or a Slice A oversight? Are existing-tenant rows backfilled by F02 or by a separate migration prompt? Does the envelope format change when real per-tenant keys land? This decision answers all three.

## Decision

The migration to real per-tenant CMEK keys is a four-step sequence; Slice B owns step 1, F02 owns steps 2–4. Envelope format does not change across the sequence.

### 1. Tenant creation MUST insert a `tenant_kms_key` row in the same transaction (Slice B)

`tenants.create(db, input, ctx)` extends to insert exactly one row in `tenant_kms_key` for the new tenant in the same transaction as the `tenant` INSERT. The row's `kms_key_resource_name` is the value returned by `@cortex/secrets.getKeyForTenant(newTenantId)` — which today resolves to the env's `cortex-general-key` per ADR-INFRA-004 §Decision 5 stub policy.

Implementation requirements:

- Single transaction with the `tenant` row creation. If `tenant_kms_key` INSERT fails (RLS misconfiguration, FK violation), the entire `tenants.create` call rolls back. We never observe a state where a `tenant` row exists without its `tenant_kms_key` row.
- The INSERT happens AFTER `bindTenantToDbSession(tx, newTenantId)` so RLS authorizes the write under the new tenant's context.
- A `TENANT_KMS_KEY_BOUND` audit event is emitted in the same transaction alongside the existing `TENANT_CREATED` event (sub-phase 5 of Slice B adds the action to `TENANT_AUDIT_ACTIONS`).

No GCP API call is made. The Phase-1 stub `getKeyForTenant` is a pure string builder; provisioning latency stays at Slice A's nominal ~50ms.

### 2. `@cortex/encryption.encryptForTenant` consults `@cortex/secrets.getKeyForTenant` (Slice B)

The encryption helper MUST call `getKeyForTenant(tenantId)` for every encrypt/decrypt operation. It MUST NOT cache resolutions or otherwise bypass the resolver — even though today's resolver returns the same env key for every tenant, F02's swap will make per-tenant resolution authoritative. Caching or bypassing would silently break post-swap by reading stale resolutions.

The `tenant_kms_key` row is INFORMATIONAL at Phase 1: encryption does not read it. F02 promotes the row to authoritative by changing `getKeyForTenant`'s implementation to query the table.

### 3. AAD-bound envelope provides the actual cryptographic tenant isolation (Slice B + permanent)

`@cortex/secrets.envelope.encrypt(tenantId, plaintext)` already sets AEAD AAD = `utf8(tenantId)`. Decryption with a different tenantId fails at the auth-tag verification step, regardless of which key the resolver returns. This guarantee holds in Phase 1 (env-shared key, AAD differs by tenant) AND in Phase 2+ (per-tenant key, AAD still differs by tenant).

Cross-tenant smuggling attempts therefore fail at the envelope layer, not at the key-resolution layer. Slice B's test suite (sub-phase 6) includes a dedicated cross-tenant decryption test asserting this failure path.

The envelope wire format is fixed across the migration:

```
[ver(1)] [wrap_len(u16)] [wrapped_DEK(L)] [IV(12)] [auth_tag(16)] [ciphertext(N)]
```

- `ver` (currently `0x01`) is reserved for future format changes.
- `wrapped_DEK` is the KMS-wrapped data-encryption key. F02's swap changes WHICH KMS key wraps the DEK; the format is unchanged.
- Existing ciphertexts decrypt unchanged after F02's swap because the DEK itself decrypts with the original wrapping key (KMS retains old key versions; rotation-then-rewrap is a separate, deferred concern — see roadmap §1.1).

### 4. Migration to real per-tenant keys (F02, Phase 2+)

When triggers from ADR-INFRA-004 fire (tenant count > ~5, OR DPA-mandated per-tenant key material, OR cryptographic-erasure-on-offboarding contractually demanded), F02 ships the swap as four additive operations:

1. **Real KMS key creation at tenant provisioning.** F02's lifecycle state machine adds a step: when transitioning a tenant from `PROVISIONING` to `ACTIVE`, create a per-tenant CMEK key in the env keyring (or a dedicated tenant-keyring per ADR-INFRA-004 §Decision 5 alternatives). Update the tenant's `tenant_kms_key.kms_key_resource_name` to the new key's resource name within the same lifecycle transaction.
2. **`getKeyForTenant` resolver swap.** Replace `packages/secrets/src/per-tenant-keys.ts` to query `tenant_kms_key` by `tenantId` (under RLS — the table's SELECT-only policy already permits the bound tenant to read its own row). Return the resolved `kms_key_resource_name` directly. The resolver caches per request (caller's transaction scope) to avoid repeated lookups.
3. **Existing-tenant row upgrade.** F02 ships a one-time migration run: for every `tenant` row, create a per-tenant key and `UPDATE tenant_kms_key SET kms_key_resource_name = <new key> WHERE tenant_id = <id>`. Audit emission: `TENANT_KMS_KEY_ROTATED` event per tenant. No data re-encryption — existing ciphertexts continue to decrypt using KMS's retained old-key-version material; new ciphertexts wrap their DEK with the new per-tenant key.
4. **Cross-tenant decryption protection unchanged.** AAD-bound envelope continues to enforce tenant isolation cryptographically. No envelope format change, no library API change for callers.

Key rotation primitives (re-wrapping existing DEKs against a new key version, periodic auto-rotation schedules) stay out of scope until F02 ships rotation explicitly. Roadmap §1.1 tracks.

## Consequences

### Positive

- **Slice B unblocks F02–F05 + D-series consumers with the API surface they need today.** D01 (PII columns) can call `encryptForTenant(db, params)` and stop worrying about key-resolution; F02's swap is invisible to D-series callers.
- **Migration to real per-tenant keys is purely additive.** No envelope format change, no data re-encryption, no library API change. F02's diff is ~50 LoC in the resolver plus a one-time backfill script. Risk surface at swap time is small.
- **`tenant_kms_key` has rows from day one.** F02 doesn't need a separate backfill step for existing tenants — the table is already populated; F02 just UPDATEs. Reduces F02's migration complexity.
- **AAD-bound envelope already prevents cross-tenant smuggling.** The cryptographic tenant-isolation property is established in Phase 1 and persists across the swap unchanged. Sub-phase 6 of Slice B locks the property with an explicit test; future audits can re-run it against any future envelope format.
- **Operational symmetry across Phase 1 and Phase 2+.** Tenants behave identically from the API surface perspective; the only difference is which KMS key wraps each DEK. Operator runbooks don't need a Phase-1-specific path.

### Negative

- **KMS billing forecast: Phase 2+ swap increases call volume.** Every tenant_kms_key row points at the same env key in Phase 1, so KMS API call volume for envelope ops is identical to the no-stub baseline. F02's swap creates one KMS key per tenant (creation cost) and one wrap call per encrypt (steady-state cost grows linearly with active tenants × per-tenant encrypt rate). Phase 2+ cost model must reflect this; ADR-INFRA-004 §Revisit triggers already includes "tenant count > ~5" as the threshold and the upgrade is well-anticipated.
- **Operator confusion potential: all `tenant_kms_key` rows reference the same env key in Phase 1.** Auditing the table during Phase 1 shows N tenants all bound to `cortex-general-key` — could mislead an operator into thinking per-tenant keys are already live. Mitigation: COMMENT ON TABLE in migration 0007 documents this exact substrate-vs-authoritative purpose ("Phase 1: empty — getKeyForTenant() in @cortex/secrets returns env-level cortex-general-key regardless of tenant ... F02 populates this table + swaps the resolver"); convention doc (Slice B sub-phase 9) repeats the framing.
- **Slice B emits one extra audit event per tenant creation (`TENANT_KMS_KEY_BOUND`).** Adds to per-tenant chain depth from creation. Mitigation: trivial — the chain trigger handles ordering; chain-volume risk is captured in P0.10 §1.5 / §1.9 (concurrent-write fork prevention, payload size) and is unchanged by this ADR.

### Neutral

- **Roadmap §1.1 (Per-tenant CMEK keys) reclassified.** Was Open. Becomes "In progress — Slice B ships substrate (`tenant_kms_key` row creation + AAD-bound envelope), F02 ships real per-tenant key creation". Resolved fully when F02's swap lands.
- **Roadmap §7.1 (`getKeyForTenant` Phase 1 stub) stays Open.** Slice B does not change the stub; F02 owns the swap. Roadmap entry unchanged in description, only cross-references this ADR.
- **No change to ADR-INFRA-004 §Decision 5.** The deferral of per-tenant keys to Phase 2+ stands. ADR-INFRA-007 documents HOW the migration happens, not WHEN — the trigger criteria in ADR-INFRA-004 §Revisit triggers are unchanged.

## References

- **ADR-INFRA-004** — CMEK key hierarchy (env-level keys, per-tenant deferred to Phase 2+)
- **ADR-AU-001** — Audit-events library (Slice B's encryption emits via this)
- **ADR-DB-002** — Row-Level Security (the SELECT-only RLS policy on `tenant_kms_key` that F02's resolver will read through)
- **F01 build prompt** at `docs/build-prompts/cortex_build_prompts_v3.md` §P1.1 §1.2.4
- **Cortex v2.2 Spec §F01-FR-004** — encryption requirements
- **Migration `services/foundation/migrations/0007_control_plane_tables.sql`** — `tenant_kms_key` table
- **`packages/secrets/src/per-tenant-keys.ts`** — current `getKeyForTenant` stub (the swap target)
- **`packages/secrets/src/kms.ts`** — envelope.encrypt/decrypt with AEAD AAD = utf8(tenantId)
- **`docs/planning/f01-slice-b-encryption-blob-isolation-scope.md`** — Slice B scope doc (companion)
- **Roadmap §1.1** — Per-tenant CMEK keys
- **Roadmap §7.1** — `getKeyForTenant` Phase 1 stub

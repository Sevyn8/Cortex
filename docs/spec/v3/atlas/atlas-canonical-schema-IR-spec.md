# Atlas Canonical Schema IR: specification (the vocabulary store)

Suggested repo location: Cortex repo, docs/spec/v3/atlas/atlas-canonical-schema-IR-spec.md
Companions: docs/spec/v3/ (architecture-spec, specification); cortex-dis libs/dis-canonical, libs/dis-mapping, services/dis-ui-server
Status: DRAFT for review. Owner: Amit. Cross-check with Sanjeev on the CM-owned items (Super Admin role, tenant-to-vertical binding) flagged in section 8.
Scope note: this specifies Atlas as the by-vertical canonical schema creator that makes DIS multi-vertical. Atlas's role in solution packs (CAC, PAC) is deliberately out of scope here.

## 1. Purpose

DIS today is retail-specific. Its canonical schema (the four `dis-canonical` Pydantic models, the `schemas/postgres` DDL, the retail enums and constrained types) is the only part of the pipeline nailed to retail. The mapping machinery is already vertical-agnostic: `libs/dis-mapping`'s `apply_mapping` renames and casts source columns to whatever canonical columns the rules name, and `dis-ui-server`'s Gemini suggester maps against a field catalog that is derived from the canonical models, not hardcoded.

Atlas makes DIS multi-vertical by replacing "one hardcoded retail canonical" with "a per-vertical canonical that Atlas generates from canonical header files." The Super Admin feeds Atlas example CRM or ERP exports for a vertical; Atlas infers a candidate canonical schema; the Super Admin reviews, edits, and ratifies it; Atlas freezes it as an immutable versioned artifact and generates the representations DIS consumes. DIS's existing onboarding (Gemini suggests, the engine applies) then runs against the generated schema for that vertical exactly as it does for retail.

The IR specified here is the single source of truth. Every downstream artifact (Pydantic models, DDL, Alembic migration, field catalog, validation scaffolds) is generated from it. Nothing downstream is hand-authored, which removes the hand-alignment and drift that `dis-canonical` carries today.

## 2. Position in the system

What Atlas owns: the per-vertical canonical schema IR (this document), its versioning and evolution, the inference that proposes a draft from header files, the human override and ratify surface, and the deterministic generation of artifacts.

What stays unchanged in DIS:
- `libs/dis-mapping`: the pure engine is already generic. No change.
- `dis-ui-server` onboarding and the Gemini suggester: already maps against a catalog derived from the canonical models. The only change is that the catalog is the generated per-vertical catalog rather than the hardcoded retail one, which is a configuration of which models it points at, not new code.
- RLS, PII tokenization, audit, receivers, dual-write: unchanged. These are pipeline invariants (see section 4).

What Customer Master owns (Sanjeev's swimlane, flagged in section 8): the Super Admin role that gates publish, and the tenant-to-vertical binding that tells onboarding which catalog to load.

## 3. The IR

The IR is one document per (vertical, schema_version). Top-level keys:

- `vertical`: stable identifier for the vertical (for example `retail`, `pharma`).
- `schema_version`: integer, monotonic. Published versions are immutable.
- `status`: one of `draft`, `published`, `superseded`.
- `generated_from`: the example export filenames the version was inferred or evolved from. Provenance.
- `system_profile`: a reference to the fixed system-column mixin (see section 4), for example `dis.v1`. Never inferred, never inline-edited.
- `types`: reusable constrained scalars, mirroring `dis-canonical/shared/types.py` (varchar lengths, numeric precision and scale).
- `enums`: named value vocabularies. Each is either a pg enum or a CHECK-constrained varchar vocabulary (the generator decides which, matching the `dis-canonical` enums convention).
- `tables`: the ordered set of canonical tables for the vertical.

Per table:

- `key`: table identifier.
- `template_type`: `snapshot` or `event`. Drives field-catalog grouping in onboarding.
- `semantics`: `merge_upsert` or `append_only`. Matches the DIS distinction between the hot table and the append-only event tables.
- `sink`: the physical canonical table, in the per-vertical namespace (see section 7), for example `canonical_pharma.prescriber_position`.
- `natural_key`: the ordered list of fields forming the upsert arbiter for a `merge_upsert` table. Curated, never inferred (see section 6).
- `fields`: the field set.

Per field:

- `name`: canonical column name (snake_case).
- `type`: a base type or a reference into `types`, or `enum` with `enum_ref`.
- `max_length` or `precision` and `scale`: as the type requires.
- `nullable`: boolean.
- `mandatory`: boolean. Whether the field must be mapped at onboarding (distinct from nullability, which is a storage property).
- `layer`: `system`, `business`, or `curated` (see section 6).
- `pii`: PII class, for example `none`, `tokenize`. Drives the receiver-side tokenization classification.
- `enum_ref`: present when `type` is `enum`.
- `origin`: `inferred` or `human`. Stamped per value; flips to `human` on any override (see section 6).
- `provenance`: `{ introduced_in: <schema_version>, source_headers: [...] }`. Which version and which source headers brought the field in.

## 4. The system mixin

`system_profile: dis.v1` is the fixed set of columns that every canonical table carries and that Atlas never infers and never exposes for inline editing. They are pipeline-injected and load-bearing for DIS invariants:

- `tenant_id` and the entity keys: scoped by RLS (the two-GUC session helper, DIS hard rule 1, decision D91).
- `mapping_version_id`: stamped by the streaming consumer on every mapping-produced row (DIS hard rule 5, decision D22).
- `trace_id`: generated by the receiver, propagated end to end (DIS hard rule 4).
- `dis_channel` and `last_updated_at`: provenance and merge bookkeeping.
- `ingest_metadata`: jsonb provenance.

Changing the mixin is not a schema edit. It alters platform invariants that RLS, version pinning, the atomic dual-write (decision D8 and D30), and PII tokenization all depend on. It therefore routes through a separate platform-level change with its own review, not through the per-vertical editor. The editor shows these columns read-only so the Super Admin can see the full shape without being able to break the contract.

## 5. Versioning and evolution

A published schema version is immutable. Evolution never edits a published version; it authors the next version as a strict superset.

Additive changes (the Super Admin happy path, applied through normal evolution):
- add a nullable or defaulted field
- add a new enum value
- add a new table or template
- widen a varchar (for example 64 to 128)
- relax a field from mandatory to optional

Breaking changes (detected, classified, and walled off; require a separate explicitly reviewed migration, never normal evolution):
- drop or rename a field
- narrow a type (would truncate existing rows)
- tighten optional to mandatory on a populated table
- change a natural key
- remove an enum value

Why superset-only holds the contract: every added column is nullable or defaulted, the migration is forward-only (ADD COLUMN, ADD enum value, CREATE TABLE), and existing rows are untouched. Rows produced under an older mapping carry null in the new column. Replay and `mapping_version_id` lineage hold with zero backfill. Existing tenant `mapping_rules` stay valid against the new version because it is a superset, so evolution never breaks live onboarding.

Evolution is propose-then-ratify, identical to creation: Atlas infers candidates from the new CSVs, diffs against the current published version, classifies each entry additive or breaking, and presents it. Inference proposes; the Super Admin ratifies; only then does Atlas cut the next version.

Shared vertical canonical versus a single tenant's extra headers: a tenant's idiosyncratic columns map to the existing `__ignore__` sentinel or a tenant-scoped extension and stay out of the shared contract. Promoting a tenant header into the shared vertical canonical is the deliberate, ratified Super Admin act. This prevents one tenant's export from silently mutating the contract every tenant of that vertical depends on.

## 6. Human override

Everything inference proposes is editable by the Super Admin before publish: field name, type, length, precision and scale, nullable, mandatory, the enum set and its values, PII class, the natural key, and table grouping. A field inference missed can be added; a field it should not have proposed can be deleted. On evolve, the override extends to the classification itself: any diff entry can be reclassified or rejected.

Two protections remain:
- The system mixin is read-only here (section 4).
- The Super Admin edits the IR (the spec), not the generated code. Models, DDL, migration, and catalog regenerate from the IR. Hand-editing a generated file would recreate the model-versus-DB drift Atlas exists to remove, so generated artifacts are deliberately not editable.

Every value carries `origin`. An edit flips the value to `origin: human`, and the publish event records it, so the audit trail shows exactly what a human overrode and what came from inference.

Field layers and what override means per layer:
- `system`: locked, platform invariant.
- `business`: inferred, edit freely.
- `curated`: keys, mandatory flags, enum vocabularies, and PII class. Inference proposes a candidate but the value must be ratified by a human before publish. A closed canonical contract is never auto-published from inference.

## 7. Generated artifacts

From one IR, the generator deterministically emits:
- the `dis-canonical`-equivalent Pydantic models for the vertical (closed, `extra="forbid"`), with the constrained types and enums
- the Postgres DDL
- the forward-only Alembic migration
- the field-catalog inputs (the labels and grouping the Gemini suggester and onboarding consume)
- the Pandera validation scaffolds (pre-mapping source-shape and post-mapping canonical-shape)

Physical storage: a separate `canonical_<vertical>` schema namespace per vertical (for example `canonical_retail.*`, `canonical_pharma.*`), recommended over a shared table with a vertical discriminator. The verticals are structurally different (retail is store by SKU; pharma is prescriber by product by territory), the natural keys and the foreign keys to `identity_mirror` differ, and separate namespaces contain blast radius: a pharma migration cannot physically touch retail. The one pipeline generalization this requires is widening the sink lookup from model-to-table to (vertical, template_type)-to-table; everything else stays generic.

This is the introspection-driven codegen that `dis-canonical` records as deferred (`tools/codegen` does not exist yet), reframed as header-driven and per-vertical. The payoff is that DDL and models cannot disagree, because both come from one source, so the hand-alignment and the inline evidence comments `dis-canonical` carries today are no longer needed; a single boot-time drift check remains as the safety net.

## 8. Authoring, gate, and surfaces

Authoring and evolution are platform-scoped privileged actions. They are gated by a Customer Master role (the Super Admin, a scope such as `atlas:schema:publish` at global scope), run behind the CM session, and every publish is written to the audit and action ledger. A TENANT user can never touch a canonical schema.

Surfaces:
1. Verticals registry: list of verticals with current version, status, bound tenants, owner.
2. Create vertical: name and upload of the example exports; header read only, nothing committed.
3. Inferred schema review and ratify: the editable field grid with the three layers, the editable enum and natural key, per-row add and delete, and the human-override marker.
4. Published schema detail: read-only catalog with per-field provenance version, the generated artifacts, and the evolve entry.
5. Evolve diff and publish: additive accepted, breaking walled off with reasons, the Super Admin gate banner.
6. Publish receipt: the post-publish confirmation (gate verified, schema frozen, artifacts generated, audit written, registry updated, tenants still zero until binding).

Atlas appears in the DIS sidebar under an Admin section, visible only when the session role is Super Admin. Selecting it opens the verticals registry. Its visibility keys off the same role that gates publish.

## 9. Worked example (retail, checkable against live dis-canonical)

```yaml
vertical: retail
schema_version: 3
status: published
generated_from:
  - posdump_acme_2026.csv
  - inventory_store12.csv
system_profile: dis.v1

types:
  money: { base: decimal, precision: 12, scale: 4 }   # Numeric12_4
  qty:   { base: decimal, precision: 14, scale: 3 }   # Numeric14_3

enums:
  tax_treatment: [INCLUSIVE, EXCLUSIVE]
  expiry_source: [PRINTED, SCANNED, ESTIMATED, CV_DETECTED]

tables:
  - key: store_sku_current_position
    template_type: snapshot
    semantics: merge_upsert
    sink: canonical_retail.store_sku_current_position
    natural_key: [store_id, sku_id, sku_variant, sku_lot_batch]
    fields:
      - { name: sku_id,               type: str,  max_length: 128, nullable: false, mandatory: true,
          layer: business, pii: none, origin: inferred, provenance: { introduced_in: 1, source_headers: ["Item Code","SKU"] } }
      - { name: current_retail_price, type: money,                 nullable: false, mandatory: true,
          layer: business, pii: none, origin: inferred, provenance: { introduced_in: 1, source_headers: ["MRP","Retail Price"] } }
      - { name: tax_treatment,        type: enum, enum_ref: tax_treatment, nullable: false,
          layer: curated,  pii: none, origin: human,    provenance: { introduced_in: 1 } }
      - { name: barcode,              type: str,  max_length: 128, nullable: true,  mandatory: false,
          layer: business, pii: none, origin: inferred, provenance: { introduced_in: 1, source_headers: ["Barcode","EAN"] } }
      - { name: loyalty_tier,         type: str,  max_length: 32,  nullable: true,  mandatory: false,
          layer: business, pii: none, origin: inferred, provenance: { introduced_in: 3, source_headers: ["Loyalty Tier"] } }
```

Evolution to v4, additive only:

```yaml
schema_version: 4
supersedes: 3
accepted_additive:
  - { change: add_field, table: store_sku_current_position, name: loyalty_points, type: qty,
      nullable: true, mandatory: false, origin: human, provenance: { introduced_in: 4, source_headers: ["Points"] } }
  - { change: add_enum_value, enum: expiry_source, value: VENDOR_DECLARED }
  - { change: add_field, table: store_sku_current_position, name: promo_channel, type: str, max_length: 64,
      nullable: true, mandatory: false, origin: inferred, provenance: { introduced_in: 4, source_headers: ["Promo Channel"] } }
rejected_breaking:
  - { change: narrow_type, field: stock_qty, from: "(14,3)", to: "(10,2)", reason: truncates existing rows }
  - { change: make_mandatory, field: barcode, reason: existing rows hold null }
```

## 10. Open items and decisions to confirm

1. Storage namespacing: separate `canonical_<vertical>` schemas (recommended) versus a shared table with a vertical discriminator. Confirm.
2. Inference engine: confirm the inference is LLM-assisted header union plus type inference, and how much weight it carries given the curated layer always requires human ratify. [verify against the intended approach]
3. CM dependencies (Sanjeev): the `atlas:schema:publish` Super Admin role and route guard, and the tenant-to-vertical binding that onboarding reads. Confirm the role vocabulary and where the binding lives.
4. Generation scope for v0: the schema layer (models, DDL, migration, field catalog) is in scope. Confirm whether the Pandera validation suites, the dbt models, and the daily-compute signals are generated in v0 or are a follow-on, given they are retail-shaped today.
5. Header-file representativeness: how many and how representative the example exports must be before inference is trustworthy, and the rule for fields that appear in some exports but not others.
6. `system_profile` versioning: how a change to the mixin (the separate platform-level path) interacts with already-published per-vertical versions. [verify]
```

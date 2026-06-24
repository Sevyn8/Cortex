# Atlas Canonical Schema IR: specification (the vocabulary store)

Suggested repo location: Cortex repo, docs/spec/v3/atlas/atlas-canonical-schema-IR-spec.md
Companions: ADR-ATLAS-001; atlas-build-plan.md; cortex-dis (libs/dis-canonical, libs/dis-validation/provenance, services/dis-ui-server/catalog, schemas/postgres, alembic)
Status: DRAFT rev 2. Owner: Amit. CM-owned items (Super Admin gate, tenant-to-vertical binding, per-vertical entity-key identity-mirror) flagged for Sanjeev.
Scope note: Atlas as the by-vertical canonical schema creator that makes DIS multi-vertical. Atlas's role in solution packs (CAC, PAC) is out of scope here.

## Changelog (rev 1 to rev 2)

Rev 2 reconciles the IR to the live DIS reality found in the A1 pre-flight. Changes:
1. Split the single `layer` field into two axes: `produced_by` (runtime production class, ground truth) and `origin` (authoring stamp). The authoring facet (system-locked / inferred / curated / declared) is now derived, not stored. Resolves the gap where compute-owned and enrichment-produced columns had no home.
2. Added per-field `default` and a compound rule for when a generated model field is Optional. Resolves the case where NOT NULL columns with a default (id, last_updated_at, regulatory_flag) are Optional.
3. Added `display_name`, `description`, `section` as authored catalog metadata. Present in the schema, active from phase A4; retail uses its existing hand-authored labels until then.
4. System profile is now per `template_type`, and entity keys are split from the invariant core.
5. Corrected the worked example (tax_treatment is enrichment-produced, not curated; id added to the mixin).

## 1. Purpose

DIS today is retail-specific. Its canonical schema (the four `dis-canonical` Pydantic models, the `schemas/postgres` DDL, the retail enums and constrained types) is the only part of the pipeline nailed to retail. The mapping engine (`libs/dis-mapping`) and the onboarding suggester (`dis-ui-server`, Gemini against a catalog derived from the models) are already vertical-agnostic.

Atlas makes DIS multi-vertical by replacing one hardcoded retail canonical with a per-vertical canonical that Atlas generates from canonical header files (example CRM or ERP exports). The Super Admin feeds Atlas the exports; Atlas infers a candidate schema; the Super Admin reviews, edits, and ratifies it; Atlas freezes it as an immutable versioned artifact and generates the representations DIS consumes. DIS's existing map-then-apply flow then runs against the generated schema exactly as it does for retail.

The IR is the single source of truth. Every downstream artifact is generated from it.

## 2. Durability principle: two axes, one source of truth

A canonical column has two independent properties that earlier conflation made brittle:

- How it is produced at runtime (`produced_by`). This is a DIS-platform fact, invariant across verticals, and it decides whether a column is mappable, computed, enriched, or injected.
- Who fills the IR cell at authoring time (the authoring facet: system-locked, inferred, curated, declared). This is what the editor's lock and edit behaviour keys off.

These correlate but are not the same. The IR stores `produced_by` as ground truth and derives the authoring facet from it. One source, no possibility of the two disagreeing, on any vertical. The field catalog's mappable set and the editor's lock state both fall out of `produced_by` rather than a hand-set layer.

## 3. The IR

One document per (vertical, schema_version). Top-level keys: `vertical`, `schema_version` (integer, monotonic, published versions immutable), `status` (`draft` | `published` | `superseded`), `generated_from` (example export filenames; provenance), `system_profile` (reference to the fixed mixin set, per template_type; section 4), `types` (reusable constrained scalars mirroring `dis-canonical/shared/types.py`), `enums` (named vocabularies, pg-enum or CHECK-varchar), `tables`.

Per table: `key`; `template_type` (`snapshot` | `event`); `semantics` (`merge_upsert` | `append_only`); `sink` (physical table in the per-vertical namespace, section 7); `natural_key` (ordered field list, the upsert arbiter for a `merge_upsert` table; members may span produced_by classes, for example a consumer-injected entity key plus mapping-produced columns); `fields`.

Per field:
- `name`: canonical column name (snake_case).
- `type`: a base type or a reference into `types`, or `enum` with `enum_ref`.
- `max_length` or `precision` and `scale`: as the type requires.
- `nullable`: boolean (the DB column nullability).
- `default`: the DB default expression, or null. Examples: `uuidv7()`, `now()`, `false`.
- `mandatory`: boolean. Whether the field must be mapped at onboarding (distinct from nullability).
- `produced_by`: one of `consumer_injected`, `db_generated`, `compute_owned`, `enrichment_produced`, `mapping_produced`. Ground truth (section 2). Mirrors `dis_validation/provenance.py` verbatim.
- `pii`: PII class (`none`, `tokenize`, ...). Drives receiver-side tokenization.
- `enum_ref`: present when `type` is `enum`.
- `origin`: `inferred` or `human`. Stamped per value; flips to `human` on any edit.
- `display_name`, `description`, `section`: authored catalog metadata. `section` is a vertical-defined grouping value (retail uses identity/product/pricing/inventory/expiry/regulatory_status; a new vertical declares its own). Active from A4.
- `provenance`: `{ introduced_in: <schema_version>, source_headers: [...] }`.

## 4. The system profile (per template_type)

`system_profile` is not a flat list. Different table classes inject different columns, so the profile is keyed by `template_type` and parameterized by the vertical's entity keys.

Invariant core (every table, every vertical, never inferred, never inline-edited): `id` (db_generated, `uuidv7()`), `tenant_id`, `mapping_version_id` (D22), `trace_id` (receiver-generated, D-rule 4), `dis_channel`, `ingest_metadata`, `last_updated_at` (db_generated, `now()`).

Per template_type additions:
- snapshot: `last_source_event_at` (consumer-injected, event-time-wins reference).
- event: `source_id`, `source_event_id` (the dedup and latest-wins arbiter, D33), and a foreign key to the vertical's snapshot table (for retail, `store_sku_current_position_id`). Specific event subtypes add their own consumer-injected columns (for example change events carry numeric before/after/change).

Per-vertical entity keys (split from the invariant core because they vary by vertical): for retail, `store_id`. For pharma, the analogue is `prescriber_id` or `territory_id`. These are `produced_by: consumer_injected` and are foreign keys into Customer Master's `identity_mirror`. They are vertical-specific but their production class and lock behaviour are the same as the core. See section 8 (Finding 4): a non-retail vertical needs a CM identity-mirror counterpart for its entity types, which is a hard dependency for that vertical.

Changing the invariant core or the per-template-type additions is a platform-level change (it touches RLS D91, version pinning D22, dual-write D8/D30, trace propagation, PII tokenization), not a per-vertical schema edit. It routes through a separate, harder-gated path. The editor shows these read-only.

## 5. Generation rules derived from the IR

Optional rule (the model field is `X | None = None`): Optional iff `nullable` OR `default is not null` OR `produced_by == db_generated`. Required otherwise. This reproduces the `dis-canonical` convention exactly (id, last_updated_at via db_generated; regulatory_flag via default; a NOT NULL no-default mapping field stays required).

Mappable set (what the field catalog offers): exactly the fields with `produced_by == mapping_produced`. Everything else (consumer_injected, db_generated, compute_owned, enrichment_produced) is generated into the model and DDL but excluded from the catalog. This is the `mapping_produced_columns` partition, generated rather than hand-maintained.

Authoring facet (derived, drives the editor):
- `consumer_injected`, `db_generated` to system, locked.
- `compute_owned`, `enrichment_produced` to declared: editable as schema (the Super Admin can add or remove such a column) but not a mapping target and excluded from the catalog. The logic that fills them (daily-compute, enrichment) is out of v0 generation scope (ADR decision 7).
- `mapping_produced` and the field is in `natural_key`, or `mandatory`, or has `enum_ref`, or `pii != none` to curated: must be human-ratified.
- `mapping_produced` otherwise to inferred: edit freely.

Ratification rule (publish gate): a published version is rejected while any curated attribute (a natural-key member, a mandatory flag, an enum vocabulary, a PII class) still carries `origin: inferred`. Ratification is the human touching the value, which flips it to `origin: human`. A closed contract is never published from an unreviewed inference.

Natural key: a `merge_upsert` table's `natural_key` generates the COALESCE-sentinel unique expression index (for retail, on `(tenant_id, store_id, sku_id, COALESCE(sku_variant,''), COALESCE(sku_lot_batch,''))`) plus the `<> ''` sentinel CHECKs on the nullable members. This is a generation template, not a passthrough.

## 6. Human override

Everything inference proposes is editable before publish: name, type, length, precision and scale, nullable, default, mandatory, the enum set and values, PII class, natural key, table grouping, and the authored catalog metadata; add a field, delete a field; on evolve, reclassify or reject any diff entry. Each edit flips the value to `origin: human` and is recorded in the publish event.

Two protections hold: the system profile (section 4) is read-only; and the Super Admin edits the IR, not the generated code (generated artifacts are regenerated, never hand-edited, which is what removes drift).

## 7. Generated artifacts

From one IR, the generator deterministically emits: the `dis-canonical`-equivalent Pydantic models (closed, `extra="forbid"`, referencing the shared constrained-type aliases and enums); the `dis_validation` provenance partition for the vertical (the five-way classification, so the boot drift check passes); the Postgres DDL; the forward-only Alembic migration (reproducing the target-safety guard idiom from versions 0001 to 0012); and the field-catalog inputs. Where labels are authored (A4), the generator emits them too; until then retail's existing hand-authored labels stand.

Physical storage is a per-vertical schema namespace. The legacy retail vertical keeps the existing `canonical.*` namespace (it predates this scheme); every new vertical is born into `canonical_<vertical>.*` (for example `canonical_pharma.*`). The namespace is declared data per vertical (retail's namespace = `canonical`), not computed by suffixing, so the historical exception lives in one legible place. The one pipeline generalization is widening the sink lookup from model-to-table to (vertical, template_type)-to-table, resolving through the declared namespace.

This is the introspection-driven codegen `dis-canonical` records as deferred (`tools/codegen`, not yet existing), reframed as header-driven and per-vertical, and it is hosted in `cortex-dis/tools/codegen` (ADR-ATLAS-001 decision 2 as amended), with logical ownership in Cortex/Atlas and the frozen IR document as the cross-repo contract.

## 8. Authoring, gate, surfaces, and the entity-key dependency

Authoring and evolution are platform-scoped privileged actions gated by a Customer Master role (Super Admin, scope such as `atlas:schema:publish` at global scope), run behind the CM session, every publish written to the audit ledger. A tenant-to-vertical binding, CM-owned, tells onboarding which catalog to load. A TENANT user can never author or evolve a schema. Atlas appears in the DIS sidebar under an Admin section, visible only when the session role is Super Admin.

Finding 4 (entity-key identity-mirror dependency): per-vertical entity keys (section 4) are foreign keys into CM's `identity_mirror`, which today holds only retail's `stores`. A non-retail vertical needs a CM identity-mirror counterpart for its entity types (for pharma, a prescriber or territory mirror) before its canonical tables can carry valid entity-key foreign keys. This is Sanjeev's swimlane. It does not block A1 (retail's `stores` exists) but is a hard gate for the first new vertical at A2.

Surfaces: verticals registry; create vertical (upload); inferred schema review and ratify (editable, with the derived authoring facet driving lock and edit state); published detail (with provenance); evolve diff and publish; publish receipt.

## 9. Versioning and evolution

Published versions are immutable; evolution authors the next version as a strict superset. Additive (normal evolution): add a nullable or defaulted field, add an enum value, add a table, widen a type, relax mandatory to optional. Breaking (detected, classified, walled off, separate reviewed migration): drop or rename, narrow a type, tighten optional to mandatory on populated data, change a natural key, remove an enum value. Migrations from evolution are forward-only, so existing rows and existing tenant mappings stay valid. Promoting a single tenant's extra header into the shared vertical canonical is the deliberate, ratified Super Admin act; a tenant's idiosyncratic columns otherwise map to the `__ignore__` sentinel or a tenant-scoped extension.

## 10. Worked example (retail, representative subset; checkable against live dis-canonical)

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
  qty:   { base: decimal, precision: 14, scale: 3 }    # Numeric14_3

enums:
  tax_treatment: [INCLUSIVE, EXCLUSIVE]
  expiry_source: [PRINTED, SCANNED, ESTIMATED, CV_DETECTED]

tables:
  - key: store_sku_current_position
    template_type: snapshot
    semantics: merge_upsert
    sink: canonical.store_sku_current_position
    natural_key: [store_id, sku_id, sku_variant, sku_lot_batch]
    fields:
      - { name: id,                   type: uuid, nullable: false, default: "uuidv7()",
          produced_by: db_generated,      origin: human }
      - { name: store_id,             type: uuid, nullable: false,
          produced_by: consumer_injected, origin: human }            # entity key, FK identity_mirror.stores
      - { name: sku_id,               type: str,  max_length: 128, nullable: false, mandatory: true,
          produced_by: mapping_produced,  origin: human,
          provenance: { introduced_in: 1, source_headers: ["Item Code","SKU"] } }   # curated (natural key)
      - { name: sku_variant,          type: str,  max_length: 128, nullable: true,
          produced_by: mapping_produced,  origin: human,
          provenance: { introduced_in: 1, source_headers: ["Variant"] } }           # curated (natural key)
      - { name: current_retail_price, type: money, nullable: false, mandatory: true,
          produced_by: mapping_produced,  origin: inferred,
          provenance: { introduced_in: 1, source_headers: ["MRP","Retail Price"] } } # curated (mandatory)
      - { name: regulatory_flag,      type: bool, nullable: true, default: "false",
          produced_by: mapping_produced,  origin: inferred,
          provenance: { introduced_in: 1, source_headers: ["Reg Flag"] } }          # inferred (Optional via default)
      - { name: tax_treatment,        type: enum, enum_ref: tax_treatment, nullable: false,
          produced_by: enrichment_produced, origin: human }          # declared, not mappable, excluded from catalog
      - { name: velocity_7day,        type: { base: decimal, precision: 10, scale: 4 }, nullable: true,
          produced_by: compute_owned,     origin: human }            # declared, daily-compute fills it (deferred)
      - { name: last_source_event_at, type: timestamptz, nullable: true,
          produced_by: consumer_injected, origin: human }            # system, snapshot profile
```

## 11. Open items and decisions to confirm

1. v0 generation scope: schema layer only (models, DDL, migration, provenance partition, field-catalog inputs). Validation suites, dbt models, daily-compute signals deferred (ADR decision 7).
2. CM role vocabulary (`atlas:schema:publish`) and the home of the tenant-to-vertical binding. Sanjeev.
3. Finding 4: the per-vertical entity-key identity-mirror counterpart in CM. Hard gate for the first new vertical. Sanjeev.
4. Inference approach (LLM-assisted header union plus type inference) and how much trust it carries, given the curated layer always requires ratify.
5. Header-file representativeness: how many and how representative the exports must be, and how to treat a field present in some exports but not others. Recorded rule for A3 (v0): union headers across the sample CSVs; a field present in some but not all files is proposed nullable with mandatory left to ratify; per-field presence (N-of-M files) and the sample size (file count, rows profiled per column) are recorded in provenance so a thin one-file inference is visibly distinguishable from a well-grounded one; no hard minimum file count in v0.
6. `system_profile` versioning: how a mixin change (the separate platform-level path) interacts with already-published per-vertical versions.
7. Labels activation: confirm `display_name`/`description`/`section` are authored-then-ratified in A4, with retail's existing labels standing until then.

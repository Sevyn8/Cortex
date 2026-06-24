# ADR-ATLAS-001: DIS goes multi-vertical via an Atlas-generated per-vertical canonical schema

Suggested repo location: Cortex repo, docs/architecture/decisions/ADR-ATLAS-001-dis-multi-vertical-via-atlas.md
Companions: docs/spec/v3/atlas/atlas-canonical-schema-IR-spec.md; docs/spec/v3/ (architecture-spec, specification); cortex-dis (libs/dis-canonical, libs/dis-validation/provenance, services/dis-ui-server, docs/decisions.md)
Status: Proposed. Ratify jointly (Amit, Sanjeev) before the DIS-side work starts, since the gate, the tenant binding, and the entity-key identity-mirror are CM-owned.
Date: June 2026
Revised: rev 2. Decision 2 amended to place the generator binary in cortex-dis/tools/codegen (ownership unchanged). Consequence 6 and open question 6 added for the per-vertical entity-key identity-mirror dependency surfaced by the A1 pre-flight.
Supersedes: the implicit assumption, in DIS and in the v3 docs, that the DIS canonical schema is retail-only and hand-authored. This ADR re-baselines the DIS canonical contract as per-vertical and generated.

## Context

DIS is described, in its own README and CLAUDE.md, as a multi-tenant retail data ETL platform. Reading the live repo, the retail coupling sits in exactly one place: the canonical schema definition. That is the four `dis-canonical` Pydantic models (hand-aligned to the live `ithina_dis_db` schema), the `schemas/postgres` DDL, and the retail enums and constrained types.

The rest of the pipeline is already vertical-agnostic:

1. `libs/dis-mapping`'s `apply_mapping` is a pure engine that renames and casts source columns to whatever canonical columns the rules name. It contains no retail logic.
2. `services/dis-ui-server` onboarding suggests a canonical field per source column (Gemini, with a deterministic fallback). It scores against a field catalog that is derived from the `dis-canonical` models, not hardcoded. The only literal retail content is the fallback synonym map, which is a degrade path.

So the mapping machinery is parameterized by the canonical schema. The schema is the only thing nailed to retail.

The platform needs to support several verticals (5 to 6 anticipated). v3 invariant 2 requires that a new vertical is configuration, not an engine commit, and engine purity is audited at every gate (BRD section 6). A second hardcoded canonical schema, copied and edited per vertical, would violate that and reintroduce the hand-alignment and drift that `dis-canonical` already carries (its codegen is recorded as deferred; `tools/codegen` does not exist).

Atlas resolves this. It is the by-vertical canonical schema creator: example CRM or ERP exports go in, an inferred candidate schema is reviewed and ratified by a human, and an immutable versioned canonical schema comes out, from which DIS's representations are generated. The schema shape is specified in the companion IR spec.

Invariant 13 (the spec-or-code drift rule) and DIS's own discipline ("don't propose architecture changes mid-slice; raise and resolve in decisions.md") require an ADR for a change of this reach. This is that ADR.

## Decision

1. DIS becomes multi-vertical by consuming a generated per-vertical canonical schema instead of a hardcoded retail one. The mapping engine and the onboarding suggester are unchanged; they already consume the canonical schema generically.

2. The Atlas canonical schema IR is the single source of truth. Every downstream artifact (the `dis-canonical`-equivalent Pydantic models, the `dis_validation` provenance partition, the Postgres DDL, the Alembic migration, the field-catalog inputs) is generated from the IR. Generated artifacts are never hand-edited; editing the IR and regenerating is the only path. This is the deferred `tools/codegen`, reframed as header-driven and per-vertical. Logical ownership of the IR, the inference, and the console stays with Cortex/Atlas; the generator binary is hosted in `cortex-dis/tools/codegen` (the reserved, not-yet-created slot), because it must import the Python Pydantic models to reconcile and emit Python, SQL, and Alembic, and Cortex is a TypeScript monorepo with no Python toolchain. The frozen IR document is the cross-repo contract between the two.

3. Physical storage is a per-vertical schema namespace, not a shared table with a vertical discriminator. The legacy retail vertical keeps the existing `canonical.*` namespace (it predates this scheme); every new vertical is born into `canonical_<vertical>.*` (for example `canonical_pharma.*`). The namespace is declared data per vertical, not computed by suffixing, consistent with the IR spec rev 2 section 7. Rationale: the verticals are structurally different, the natural keys and the foreign keys to `identity_mirror` differ, and separate namespaces contain blast radius so a new vertical's migration cannot touch an existing one. The only pipeline generalization required is widening the sink lookup from model-to-table to (vertical, template_type)-to-table.

4. Published schema versions are immutable and evolution is superset-only. Additive changes flow through normal evolution; breaking changes are detected, classified, and walled off, requiring a separate explicitly reviewed migration. Migrations generated by evolution are forward-only, so existing rows and existing tenant mappings stay valid.

5. A canonical column carries two independent properties: `produced_by` (its runtime production class, ground truth, mirroring `dis_validation/provenance.py`) and `origin` (`inferred` or `human`, the authoring stamp). The authoring facet (system-locked, inferred, curated, declared) is derived from `produced_by` plus the field's own attributes, never stored, so the field catalog's mappable set and the editor's lock state cannot disagree. Everything inference proposes is human-overridable before publish; publish is rejected while any curated attribute still carries `origin: inferred`. Two protections hold: the system profile is read-only because it underpins RLS (D91), version pinning (D22), the dual-write (D8, D30), trace propagation, and PII tokenization; and generated code is regenerated, not hand-edited.

6. Authoring and evolution are platform-scoped privileged actions, gated by a Customer Master role (Super Admin, scope such as `atlas:schema:publish` at global scope), run behind the CM session, with every publish written to the audit and action ledger. A tenant-to-vertical binding, also CM-owned, tells onboarding which vertical catalog to load. A TENANT user can never author or evolve a canonical schema. Atlas appears in the DIS sidebar under an Admin section, visible only when the session role is Super Admin.

7. v0 generation scope is the schema layer: the Pydantic models, the provenance partition, the DDL, the forward migration, and the field-catalog inputs. Generating the Pandera validation suites, the dbt models, and the daily-compute signals per vertical is a follow-on, since those are retail-shaped today and need their own generalization.

## Consequences

1. The DIS canonical contract changes from hand-authored retail to generated per-vertical. A companion entry should be added to cortex-dis `docs/decisions.md` (the next D-number) when the DIS-side namespacing and sink-generalization slice starts, cross-referencing this ADR.

2. Retail is re-expressed as an Atlas IR and regenerated. This doubles as the strongest first acceptance test: the generator must reproduce the live `dis-canonical` models, the provenance partition, and the DDL from retail's IR with zero regression before any new vertical is attempted.

3. Adding a vertical becomes: feed Atlas the example exports, review and ratify the proposed schema, publish, and let Atlas generate the artifacts and one forward migration. Zero engine commits, zero pipeline commits. This is invariant 2 holding for canonical schemas the same way it holds for packs. Any vertical-specific code landing outside the IR and its generated artifacts is drift and is reshaped or declined.

4. CM gains responsibilities (Sanjeev's swimlane, flagged not assumed): the Super Admin role and route guard that gate publish, and the tenant-to-vertical binding. Both can be stubbed (like the pack signing stub) so the Atlas console and publish flow are testable before the real CM gate lands.

5. The `dis-canonical` hand-alignment and its inline evidence comments are retired for generated verticals, replaced by one boot-time drift check between the generated models, the generated provenance partition, and the labels. The crashloop-on-drift behavior is preserved.

6. Per-vertical entity keys are a CM dependency. Entity keys (retail's `store_id`; pharma's prescriber or territory analogue) are `consumer_injected` and are foreign keys into CM's `identity_mirror`, which today holds only retail's `stores`. A non-retail vertical needs a CM identity-mirror counterpart for its entity types before its canonical tables can carry valid entity-key foreign keys. This does not block A1 (retail's `stores` exists) but is a hard gate for the first new vertical at build phase A2. Sanjeev's swimlane.

## Open questions deferred to ratification

1. v0 generation scope: confirm the schema layer only (decision 7), with validation suites, dbt models, and daily-compute generation as a follow-on.
2. The CM role vocabulary (`atlas:schema:publish` or equivalent) and the physical home of the tenant-to-vertical binding. Sanjeev.
3. The inference approach (LLM-assisted header union plus type inference) and how much trust it carries, given the curated layer always requires human ratify.
4. The header-file representativeness rule: how many and how representative the example exports must be, and how to treat a field present in some exports but not others.
5. `system_profile` versioning: how a change to the mixin (the separate platform-level path) interacts with already-published per-vertical versions.
6. The per-vertical entity-key identity-mirror counterpart in CM (consequence 6). What identity-mirror shape a new vertical's entity types require, and the contract by which DIS foreign keys reference it. Hard gate for the first new vertical. Sanjeev.

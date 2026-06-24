# Atlas multi-vertical build plan

Suggested repo location: Cortex repo, docs/spec/v3/atlas/atlas-build-plan.md
Companions: ADR-ATLAS-001; atlas-canonical-schema-IR-spec.md; cortex-dis (libs/dis-canonical, libs/dis-mapping, services/dis-ui-server)
Status: DRAFT. Owner: Amit. CM items (A5) need Sanjeev sign-off; stubbed until then.
Spine: spec-first (the IR is landed and canonical). Generator before inference (build the deterministic core, prove it against retail, then add the convenience layer). Retail is the zero-regression prover; pharma is the net-new multi-vertical proof. Stub the CM gate early so the console is testable, real gate as a flagged follow-on.

## Ownership map

- Cortex / Atlas owns: the IR, the generator, the inference, the override editor and the console surfaces.
- DIS owns: the per-vertical namespacing and the sink generalization, and it consumes the generated artifacts.
- Customer Master (Sanjeev) owns: the Super Admin publish gate and the tenant-to-vertical binding.

## Phases

### A1. The generator (IR to artifacts), retail as prover

Goal: a deterministic generator that takes a ratified IR and emits the `dis-canonical`-equivalent Pydantic models, the Postgres DDL, the forward-only Alembic migration, and the field-catalog inputs.
Lands in: Cortex / Atlas.
Depends on: the IR spec (landed).
Why first: it is the load-bearing deterministic core. Retail's IR can be hand-authored, so the generator is provable without inference. Build and prove the core before the convenience layer, mirroring the pack discipline (loader-against-fixture before signing and publish).
Acceptance: author retail's IR by transcribing the live `dis-canonical` models; regenerate; the generated models and DDL reconcile to the live `ithina_dis_db` schema with zero regression (the codegen prover). The boot-time drift check passes.

### A2. Per-vertical namespacing and sink generalization (DIS)

Goal: DIS can host more than one vertical's canonical tables. Generalize the sink lookup from model-to-table to (vertical, template_type)-to-table; create and target the `canonical_<vertical>` schema namespace; the streaming consumer and daily-compute write to the right namespace for a tenant's vertical.
Lands in: DIS.
Depends on: A1 (the generator emits the namespaced DDL). The tenant-to-vertical resolution can be stubbed until A5.
Acceptance: retail continues to ingest unchanged in its existing `canonical.*` namespace (no rename); a second namespace `canonical_<vertical>.*` can be created from a generated migration without touching retail.

### A3. Inference (CSVs to draft IR)

Goal: propose a draft IR from example exports. Header union across the sample files plus type and length inference, LLM-assisted, with the curated layer (keys, mandatory, enums, PII) flagged for ratify rather than decided.
Lands in: Cortex / Atlas.
Hosts physically in cortex-dis (dis-ui-server inference plus tools/codegen for the draft-IR schema), with logical ownership in Cortex/Atlas, mirroring the A1 generator. A3 uses the existing DIS Vertex generative boundary (the dis-ui-server `_call_model` seam), not the Cortex A05 gateway; the A05 guardrail is a Cortex construct and does not bind DIS.
Depends on: the IR shape only; sequenced after A1 so the consumer of a ratified IR exists.
Acceptance: feed retail's example exports; the proposed IR is close to the hand-authored retail IR (measured by diff), with every curated item flagged and every value stamped `origin: inferred`.

### A4. Override editor and the console surfaces

Goal: the Atlas console: registry, upload, the editable ratify grid (with add and delete, editable enum and natural key, the human-override marker), published detail, evolve, and the publish receipt, plus the DIS sidebar entry (Super Admin only). Publish freezes the IR and triggers A1 generation.
Lands in: Cortex / Atlas (surfaces), DIS sidebar wiring.
Depends on: A1 (generation on publish), A3 (a draft to edit).
Acceptance: a Super Admin uploads exports, edits the inferred schema, every edit flips the value to `origin: human`, publish freezes an immutable version and produces the artifacts, and the receipt shows the result.

### A5. CM gate and tenant-to-vertical binding (Sanjeev swimlane)

Goal: the `atlas:schema:publish` Super Admin role and route guard, the audit-ledger publish event, and the tenant-to-vertical binding that onboarding reads.
Lands in: Customer Master; consumed by Atlas and DIS.
Depends on: nothing technically, but it is CM-owned. Stub it early (a static role check and a local binding) so A4 is testable; swap in the real CM gate when ready.
Acceptance: a non-Super-Admin cannot reach publish or see the Atlas sidebar entry; a publish writes an audit event; onboarding loads the catalog for the tenant's bound vertical.

### A6. Evolution (superset diff and forward migration)

Goal: the diff engine (new CSVs against the published IR), the additive-versus-breaking classification, the forward-only migration generation for additive changes, and the evolve-and-publish path wired to the evolve surface.
Lands in: Cortex / Atlas, with DIS applying the forward migration.
Depends on: A1 (migration generation), A4 (the evolve surface).
Acceptance: a new export with new headers produces a correct diff; additive changes publish as the next version with a forward-only migration; breaking changes are walled off with reasons and are not applied; existing rows and existing tenant mappings remain valid.

## Provers

- Generator prover (A1): retail regenerated from its IR reconciles to the live schema, zero regression.
- Multi-vertical prover (A2 to A6): pharma authored net-new. A whole new vertical reaches ingestion via example exports, ratify, publish, generate, and one forward migration, with zero engine commits and zero pipeline commits. This is the invariant-2 test for canonical schemas.

## Deferred (v0 boundary, explicit)

1. Generation of the Pandera validation suites per vertical (retail-shaped today).
2. Generation of the dbt models per vertical.
3. Generation of the daily-compute signals per vertical.
4. The real CM gate and role, if stubbed in A5.
5. The `system_profile` (mixin) versioning path and its interaction with published per-vertical versions.
6. Multi-table foreign-key generation nuances beyond the single-table snapshot and event shapes.

Each deferred item is parked deliberately with the phase that un-parks it noted above; none blocks the A1 to A6 critical path.

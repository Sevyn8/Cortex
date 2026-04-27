# Multi-Domain Separation Audit — Cortex Platform Substrate

**Status:** Audit findings; not a decision document
**Date:** 2026-04-27
**Auditor:** Claude (read-only audit; zero code changes)
**Scope:** Two-layer audit of how Cortex separates data:

1. **Tenant** separation (the well-established axis — verify and quantify)
2. **Domain** separation (Retail / Smart Home / Logistics — classify the strategy)
   **Inputs:** Full Cortex repo at commit `35e1984` (F02 Slice A landed)
   **Companion documents:** ADR-DB-001, ADR-DB-002, ADR-DB-003, ADR-INFRA-007, ADR-SCOPE-009, ADR-LIFECYCLE-001

---

## Executive summary

**Cortex is `pre-domain`.** Phase 1 has shipped a platform substrate that is rigorously tenant-isolated but contains zero domain-specific schema, zero domain-specific code, and zero domain-specific storage strategy. Across 10 migrations (0001–0010) and 6 Drizzle tables, every row-bearing table is platform infrastructure (`tenant`, `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`, `audit_event`, `bootstrap_admin`); none of them carry a domain discriminator column. RLS is exclusively `tenant_id = cortex.current_tenant_id()` — never `WHERE domain = 'retail'` or any equivalent shape — so the "RLS being misused for domain separation" question has a clean **NO** answer with evidence. The architectural choice between physical (per-domain Postgres schemas / dedicated storage), hybrid (domain-dedicated tables on shared substrate), or logical-only (discriminator column) separation is **still open** and deferred to Phase 2+ when the first domain feature lands. Display Data's CV pipeline, Smart Home telemetry, and Logistics geospatial are mentioned only in spec / ADR prose; no implementation prejudges the answer.

---

## Detailed findings

### STEP 1 — Schema state inventory

**Migration count:** 10 raw-SQL migrations applied, sequential 0001–0010.

| Migration                             | Purpose                                                                   | Domain-relevant? |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------- |
| 0001_extensions.sql                   | `pgcrypto`, `vector`, `btree_gist`, `CREATE SCHEMA cortex`                | Platform         |
| 0002_bi_temporal_helpers.sql          | `cortex.at_time_t`, `cortex.cortex_scd_trigger()`                         | Platform         |
| 0003_rls_baseline.sql                 | `cortex.current_tenant_id()` reader, policy templates as comments         | Platform         |
| 0004_audit_chain.sql                  | `audit_event` table + SHA chain trigger                                   | Platform         |
| 0005_bootstrap_admin.sql              | Pre-AC01 super-admin placeholder                                          | Platform         |
| 0006_bi_temporal_ms_truncation.sql    | µs→ms canonicalization fix                                                | Platform         |
| 0007_control_plane_tables.sql         | `tenant`, `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key` | Platform         |
| 0008_audit_event_actor_type_agent.sql | Add `agent` to actor_type CHECK                                           | Platform         |
| 0009_tenant_kms_key_writes_policy.sql | Tighten `tenant_kms_key` RLS to FOR ALL                                   | Platform         |
| 0010_tenant_lifecycle_metadata.sql    | F02 Slice A status enum + 5 lifecycle columns                             | Platform         |

**Drizzle schema declarations** (`packages/canonical-schema/src/drizzle/schema.ts`, 278 lines, lines cited by table):

- `bootstrapAdmin` (line 50) — pre-AC01 admin placeholder
- `tenant` (line 92) — control plane registry
- `tenantConfigVersion` (line 137) — versioned per-tenant config
- `tenantQuotaUsage` (line 173) — quota counter rows
- `tenantKmsKey` (line 204) — per-tenant CMEK binding
- `auditEvent` (line 250) — tamper-evident audit log

**Categorization:** All 6 tables are platform substrate. Zero domain (retail / IoT / logistics) tables. No `orders`, `devices`, `telemetry`, `shipments`, `products`, `transactions`, `sensors`, `locations`, `routes`, or any vertical-specific entity exists in the schema.

### STEP 2 — Migration CREATE TABLE inspection

Only one named Postgres schema is created across all 10 migrations: **`cortex`** (`0001_extensions.sql:28`), and its purpose is documented in the schema COMMENT (line 31–32) as **"Platform-owned SQL surface: bi-temporal helpers, RLS readers, audit-chain functions"** — i.e., the `cortex` schema holds **functions and triggers**, not data tables. Every CREATE TABLE statement omits a schema qualifier, landing the table in `public`. There are no `retail`, `smarthome`, `iot`, `logistics`, or `cortex_data` schemas.

CREATE TABLE statements (sourced from each migration, line-cited):

- `bootstrap_admin` — `0005_bootstrap_admin.sql:25`
- `audit_event` — `0004_audit_chain.sql:78`
- `tenant` — `0007_control_plane_tables.sql:50`
- `tenant_config_version` — `0007_control_plane_tables.sql:74`
- `tenant_quota_usage` — `0007_control_plane_tables.sql:100`
- `tenant_kms_key` — `0007_control_plane_tables.sql:129`

**Polymorphic patterns search:**

- `audit_event.action` (`0004_audit_chain.sql:84`) and `audit_event.resource` (`0004_audit_chain.sql:85`) are free-form `text` — these are the only audit-discriminator columns. Audit actions are namespaced via the `@cortex/audit-events` registry (`registerAuditActions(...)` at `packages/audit-events/src/types.ts:42`). The `@cortex/tenant-context` catalog (`packages/tenant-context/src/audit-actions.ts:18`) registers 10 names — all `TENANT_*` (tenant lifecycle), zero domain-namespaced (no `RETAIL_*`, `IOT_*`, `LOGISTICS_*`, `ORDER_*`, `DEVICE_*`).
- `audit_event.payload` is `jsonb DEFAULT '{}'` (`0004_audit_chain.sql:86`) — but this is per-event metadata, not row data.
- `tenant_config_version.config_json` is `jsonb DEFAULT '{}'` (`0007_control_plane_tables.sql:78`) — per-tenant config, not domain-discriminated.
- `tenant_quota_usage.resource_class` is free-form `text` (`0007_control_plane_tables.sql:103`); the convention doc (CLAUDE.md "Quotas + Compute Placement") restricts values to `api_calls_per_minute`, `cpu_seconds`, `ram_mb`, `db_connections` — all platform resources, none domain-coupled.

There is **no** EAV-style `entities`/`attributes`/`values` triple, no shared `records (type text, data jsonb)` mega-table, no polymorphic generic carrier. The substrate is strongly typed and platform-coherent.

### STEP 3 — Drizzle schema column shape

Per-table column shape (`packages/canonical-schema/src/drizzle/schema.ts`):

**`tenant`** (line 92–127):

- Discriminators: `tier text enum ['STANDARD', 'ENTERPRISE']` (line 96), `status text enum [...7 lifecycle states...]` (line 97–106)
- Lifecycle metadata: `last_key_rotated_at`, `terminated_at`, `offboarding_grace_until` (line 115–117), `legal_hold` boolean (line 122), `dedicated_db_approved` boolean (line 126)
- **No `domain` / `vertical` / `category` column.** The `tier` column is _commercial_ tier (deployment-shape gate per ADR-LIFECYCLE-001 + ADR-COMPUTE-001), not a domain tag — CLAUDE.md is explicit: _"`placement` label is **deployment shape**, NOT commercial tier. `tenant.tier` is the commercial tier; lives in DB."_

**`tenant_config_version`** (line 137–155):

- `config_json jsonb` (line 145) is the per-tenant configuration carrier; F02 will house quota overrides at `config_json.quotas[resource_class]` (per `packages/quotas/src/config.ts:65`). Nothing in the schema reserves a key like `config_json.domain` — domain config has not been imagined yet.

**`tenant_quota_usage`** (line 173–191):

- `resource_class text` (line 180) is the only discriminator. No domain dimension.

**`tenant_kms_key`** (line 204–213):

- Single `kms_key_resource_name` column. One key per tenant; not "one key per (tenant, domain)".

**`audit_event`** (line 250–275):

- `action text` (line 260) is the discriminator; values come from registered catalogs (e.g., `TENANT_CREATED`).
- `resource text` (line 261) is free-form; today only `tenant`, `tenant_config_version`, `tenant_kms_key` appear — no domain entities.
- `payload jsonb` (line 262) is per-event metadata.

**Summary:** Tables are _strongly typed_ per platform concern, not generic-with-discrimination. The only enums in the schema (`tier`, `status`, `actor_type`, `env_created_in`) are platform vocabularies, not domain selectors.

### STEP 4 — Domain-specific code search

Filesystem grep across `packages/`, `services/`, `apps/` (excluding `node_modules`):

- **`retail` / `Retail`:** zero matches in code. Mentions only in `docs/architecture/decisions/ADR-SCOPE-009-roos-external.md` (line 12, 36, 38, 48, 50, 60, 64, 77, 91, 144) and `docs/architecture/decisions/ADR-MCP-001-cortex-is-mcp-native.md` (line 25).
- **`smarthome` / `smart_home` / `IoT` / `iot` / `telemetry` / `sensor` / `device`:** all hits are `@opentelemetry/*` substring matches in `packages/observability/src/{sdk,tracer,grpc-middleware,pubsub-wrapper,metrics,http-middleware}.ts`. Verified by whole-word grep (`grep -wn "iot|telemetry|sensor|device|smarthome"`) — only one true match: `services/foundation/test/helpers/db.ts:26` references "Bash's /dev/tcp pseudo-**device**" in a comment about TCP probing.
- **`logistics` / `Logistics` / `shipment` / `tracking` / `fleet` / `warehouse`:** zero matches anywhere in the repo.
- **`Ithina` / `DisplayData` / `ROOS` / `roos`:** zero matches in code. Mentions only in `docs/architecture/decisions/ADR-SCOPE-009-roos-external.md` and the spec.

**Service-tree placeholder dirs** (`services/`):

- `services/industry/.gitkeep` exists — the scaffold reserves the location for vertical industry services, but the directory contains no code.
- `services/data-platform/`, `services/ingestion/`, `services/edge/` etc. are all empty.

**DIS / ROOS connector code:** None present. Per ADR-SCOPE-009 (Decision Path A), Cortex consumes from `dis.golden.roos` as an external Kafka topic via the G01 connector framework — but G01 itself is not yet implemented (`services/ingestion/` is empty). The integration is documented as a Phase 1 deliverable but has not been built.

### STEP 5 — RLS policies (the critical question)

**Every RLS policy declared across all 10 migrations:**

| Policy                                        | Table                   | Predicate                                                              | Source                                     |
| --------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `tenant_read_policy`                          | `audit_event`           | `tenant_id = cortex.current_tenant_id()`                               | `0004_audit_chain.sql:151`                 |
| `tenant_write_policy`                         | `audit_event`           | `tenant_id = cortex.current_tenant_id()` (USING + WITH CHECK)          | `0004_audit_chain.sql:156`                 |
| `tenant_config_isolation`                     | `tenant_config_version` | `tenant_id = cortex.current_tenant_id()` (FOR ALL)                     | `0007_control_plane_tables.sql:89`         |
| `tenant_quota_usage_isolation`                | `tenant_quota_usage`    | `tenant_id = cortex.current_tenant_id()` (FOR ALL)                     | `0007_control_plane_tables.sql:119`        |
| `tenant_kms_key_isolation` (initial)          | `tenant_kms_key`        | `tenant_id = cortex.current_tenant_id()` (FOR SELECT only)             | `0007_control_plane_tables.sql:146`        |
| `tenant_kms_key_isolation` (extended in 0009) | `tenant_kms_key`        | `tenant_id = cortex.current_tenant_id()` (FOR ALL, USING + WITH CHECK) | `0009_tenant_kms_key_writes_policy.sql:25` |

**Tables with RLS DISABLED** (control plane / pre-tenant):

- `tenant` — explicitly NOT RLS-protected. Schema docstring (line 78–83 of `schema.ts`): _"Control plane — NOT RLS-protected."_ Tenant identifiers must be discoverable without a bound tenant context (e.g., during provisioning by the lifecycle service).
- `bootstrap_admin` — pre-tenant identity bootstrap, RLS irrelevant.

**Predicate uniformity:** Every policy applied to a tenant-scoped data table uses **identical** predicate text: `tenant_id = cortex.current_tenant_id()`. Zero policies reference any other column. Zero policies have a domain dimension.

**Architectural mandate.** ADR-DB-002 §"Decision" specifies _"two policy templates (`tenant_read_policy`, `tenant_write_policy`)"_ and §"Alternatives considered" #2 (line 119+) explicitly rejects per-tenant schemas — but the rejection is for **tenant** separation reasons (unbounded count, F02 dynamic provisioning incompatibility, broken shared query plans). The reasoning does not transfer wholesale to **domain** separation, where the count is bounded (≤10 verticals over the lifetime of the platform).

### STEP 6 — ADR review

**ADR-DB-001 (bi-temporal data model):** Mentions "domain" three times (lines 13, 76, 126). Each instance refers to "domain fields" or "domain tables" in the _Phase 1 D01 / F0X_ sense — i.e., business-data tables generally (anything that isn't an audit/control-plane row). Not in the vertical-domain (retail/IoT/logistics) sense. The ADR is silent on multi-vertical separation.

**ADR-DB-002 (RLS contract):** Tenant-only. §"Decision" lists `app.tenant_id` as the _only_ session variable; explicitly rejects `app.actor_id`, `app.role`, "or any other session vars." §"Alternatives considered" rejects (#2) per-tenant schemas, (#3) per-tenant Postgres roles, (#4) session-scoped GUC, (#5) unqualified GUC names. The ADR does not contemplate or permit a domain-scoped predicate. **It is structurally impossible** for a domain predicate to be added to RLS without amending this ADR.

**ADR-DB-003 (audit SHA chain):** Tenant-only chains; per-tenant `prev_hash` linkage. No domain cross-cutting.

**ADR-INFRA-007 (per-tenant CMEK migration path):** Phase 1 uses one env-level `cortex-general-key`; Phase 2 swaps to per-tenant keys. No domain-keyed CMEK strategy is mentioned. The migration document is `docs/architecture/decisions/ADR-INFRA-007-per-tenant-cmek-migration-path.md`.

**ADR-SCOPE-009 (ROOS/DIS external):** Path A locks "ROOS remains external; Cortex consumes from `dis.golden.roos`." All `retail` mentions in this ADR are descriptive (Display Data is a retail client; ROOS ingests retail POS events) — none of them ascribe domain-separation strategy to Cortex. Cortex's job is to consume retail-flavored events from an external pipeline, not to physically separate them from non-retail events at the schema level.

**ADR-LIFECYCLE-001 (state machine + Cloud Tasks):** Tenant lifecycle only. No domain concept.

**ADR-MCP-001 (Cortex is MCP-native):** Line 25 says _"Cortex is not a generic B2B SaaS. It is a vertical intelligence platform that packages AI capabilities... for retail clients."_ This is _positioning_ prose, not a domain-separation prescription. Line 54 considers and rejects "further splits (by consumer type, by data sensitivity, by capability domain)" for the MCP server topology — i.e., MCP servers are not split by domain — but this is about MCP topology, not data storage. Line 203 acknowledges that _"internal tool growth outpaces what three servers can cleanly serve"_ would justify splitting by capability domain — a future-only concern.

**Search result:** Zero ADRs prescribe physical / hybrid / logical-only domain separation. The architectural decision is **un-made**.

### STEP 7 — Query patterns

Drizzle query inventory (`grep -rn '\.from(\|\.insert(\|\.update(\|\.delete(' packages/*/src/`):

- `packages/quotas/src/config.ts:65` — `.from(tenantConfigVersion)`
- `packages/compute-placement/src/get-placement.ts:74` — `.from(tenant)`
- `packages/secrets/src/per-tenant-keys.ts:59` — `.from(tenantKmsKey)`
- `packages/tenant-context/src/tenants.ts:245, 307, 349, 368, 391, 396, 433, 453, 516, 528` — `.insert(tenant)`, `.from(tenant)`, `.update(tenant)`, etc.
- `packages/tenant-context/src/provisioning-worker.ts:173, 200, 212` — `.from(tenant)`, `.from(tenantKmsKey)`

**Schema-qualified queries:** Zero matches for `FROM \w+\.` regex (e.g., `FROM retail.orders`). Every Drizzle reference is to an _unqualified_ `pgTable` declaration which lands in `public` by default.

**Domain-discriminator filters:** Zero `WHERE domain = '...'`, `WHERE entity_type = '...'`, `WHERE vertical = '...'` clauses anywhere in the codebase.

**Conclusion:** Today's query layer cannot distinguish a "retail" row from a "logistics" row because the distinction does not exist in the data model.

### STEP 8 — Indexes

**Production indexes** (CREATE INDEX statements outside comments):

- `audit_event_tenant_time` on `audit_event (tenant_id, occurred_at DESC, event_id)` — `0004_audit_chain.sql:93`

That is the **only** non-PK / non-UNIQUE index in production today.

**Bi-temporal index recipe** (documentation in `0002_bi_temporal_helpers.sql:44–48` as a SQL comment block):

```sql
CREATE INDEX <t>_temporal_gist ON <t> USING gist (tenant_id, valid_time, txn_time);
CREATE INDEX <t>_tenant_current ON <t> (tenant_id) WHERE upper(txn_time) IS NULL;
```

The recipe leads on `tenant_id` — and ADR-DB-001 §"Indexing convention" #4 entrenches this. There is no template for a `(domain, tenant_id, ...)` or `(tenant_id, domain, ...)` index. Every D01 / module migration that adopts the bi-temporal pattern will inherit a tenant-scoped GiST index — domain dimensions would have to be retrofitted explicitly.

**Domain-prefixed index names** (`retail_*`, `smarthome_*`, `logistics_*`): zero.

### STEP 9 — Storage strategy beyond Postgres

**Terraform modules** (`infra/terraform/modules/`):

```
artifact-registry  ci-runner          cloud-sql           cloud-tasks-queue
kms                monitoring         networking          project-baseline
secret             tenant-data-bucket wif
```

- `cloud-sql` — single Postgres instance per env (`ADR-INFRA-005`).
- `tenant-data-bucket` — single GCS bucket per env (`cortex-{env}-tenant-data`, `infra/terraform/modules/tenant-data-bucket/main.tf:34–48`). Tenant isolation via `tenants/{tenantId}/` object-key prefix per `@cortex/blob-storage` (CLAUDE.md "Encryption + Blob Storage"). **Bucket-per-tenant deferred to F02** (per ADR-INFRA-007 + Slice B planning Decision 4); **bucket-per-domain not contemplated.**
- `cloud-tasks-queue` — generic queue module landed in F02 Slice A.

**Other storage technologies** (`grep -rln 'BigQuery|Spanner|Bigtable|Firestore|TimescaleDB|InfluxDB|PostGIS|postgis'`):

- Zero matches across `packages/`, `services/`, `infra/`, `apps/`.

**Implications:**

- IoT / Smart Home telemetry would today land on Postgres rows — there is no time-series store provisioned. (TimescaleDB / BigQuery / Bigtable are conventional fits and **none are present**.) When IoT lands, this becomes an active design question, not a substrate question.
- Logistics geospatial would land on Postgres — but `PostGIS` is not enabled (`0001_extensions.sql` lists `pgcrypto`, `vector`, `btree_gist` only). The ranged geospatial queries logistics needs would not be tractable on plain Postgres.
- All Phase 1 platform data is in one Postgres instance; isolation is per-tenant via RLS and per-tenant via GCS path prefix. There is no parallel storage axis where domains could be implicitly separated.

---

## Classification + evidence

### A. Tenant separation: **Strong (verified)**

Quantified evidence:

| Layer                 | Mechanism                                                                                                                                   | Status                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Postgres rows         | RLS (`tenant_id = cortex.current_tenant_id()`) on every tenant-scoped table                                                                 | 6 policies across 4 tables; uniform predicate                                 |
| Postgres session      | Fail-closed `cortex.current_tenant_id()` raises `42501` when `app.tenant_id` unset                                                          | `0003_rls_baseline.sql`; ADR-DB-002 §3                                        |
| Audit chain           | Per-tenant SHA chain (rows linked by `prev_hash` within a tenant)                                                                           | `0004_audit_chain.sql:99–144`; ADR-DB-003                                     |
| Encryption (envelope) | AAD = `utf8(tenantId)` — cross-tenant decrypt fails at AEAD auth-tag                                                                        | `packages/secrets/src/kms.ts:107, 213`; CLAUDE.md "Encryption + Blob Storage" |
| Blob storage          | Object-key prefix `tenants/{tenantId}/` enforced by `@cortex/blob-storage` validators (`buildFullObjectPath`, `assertObjectInTenantPrefix`) | `packages/blob-storage/src/*`                                                 |
| CMEK                  | Phase 1: env-level `cortex-general-key`. Phase 2: per-tenant CMEK (substrate row in `tenant_kms_key`; resolver swap path documented)        | ADR-INFRA-004, ADR-INFRA-007                                                  |
| Compute (Enterprise)  | Per-tenant Cloud Run service (`{workload}-tenant-{uuid}`) on Enterprise tier                                                                | `packages/compute-placement/src/get-placement.ts`; ADR-COMPUTE-001            |
| Quotas                | Per-`(tenant, resource_class)` token bucket; UNIQUE `(tenant_id, resource_class, window_start)`                                             | `0007_control_plane_tables.sql:108`; CLAUDE.md "Quotas + Compute Placement"   |

**Classification: Strong, defense-in-depth.** Tenant isolation is enforced at four independent layers (DB RLS, AAD-bound encryption, GCS path validators, Enterprise per-tenant Cloud Run). Application-layer bugs cannot exfiltrate cross-tenant data without simultaneously breaking the cryptographic AAD binding and the RLS predicate.

### B. Domain separation: **Pre-domain**

The four candidate classifications:

1. **Pre-domain** — no vertical-specific code yet; platform substrate only; the domain-architectural decision is still open.
2. Logical/semantic only — domains exist as discriminator values in shared tables.
3. Hybrid — some domain-dedicated tables on shared platform substrate.
4. Physical — separate Postgres schemas (retail.\*, smarthome.\*) or separate physical storage strategies per domain.

**Cortex today: classification 1 (pre-domain).**

**Evidence summary:**

| Evidence axis                | Pre-domain indicator                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ----- | ---- |
| Migrations 0001–0010         | Zero domain tables; only platform substrate                                                      |
| Drizzle pgTable declarations | 6 tables, 6 platform; 0 domain                                                                   |
| Postgres schemas             | Only `cortex` (helper functions) + `public` (data). No `retail`, `smarthome`, `logistics`, `iot` |
| Domain code (`grep retail    | logistics                                                                                        | ...`) | Zero |
| RLS policies                 | Uniformly `tenant_id = ...`. No `domain = ...` predicate exists                                  |
| Drizzle query layer          | Zero schema-qualified queries; zero domain discriminator filters                                 |
| Indexes                      | One production index, tenant-scoped. Bi-temporal index recipes tenant-scoped                     |
| Storage diversity            | Postgres + GCS only. No BigQuery / TimescaleDB / Bigtable / PostGIS                              |
| ADR direction                | No ADR prescribes a domain-separation strategy                                                   |
| Service-tree intent          | `services/industry/.gitkeep` exists as a placeholder; no code                                    |

**Why not classification 2 (logical-only)?** A logical-only architecture would have at least one shared row-store table with a domain discriminator column (`domain text` or `entity_type text` indexing into a polymorphic `data jsonb`). No such table exists. Even `audit_event.action` is platform-namespaced (`TENANT_CREATED`, etc.), not domain-namespaced.

**Why not classifications 3 or 4 (hybrid / physical)?** The relevant artifacts (domain-dedicated tables; named Postgres schemas; per-domain storage modules; per-domain CMEK keys; per-domain ADRs) are all absent.

### C. Honest verdict on RLS misuse — **NO.**

**Evidence:**

- All 6 RLS policies use the same predicate: `tenant_id = cortex.current_tenant_id()` (sources cited in STEP 5).
- Zero policies use any other column.
- ADR-DB-002 §"Decision" explicitly defines RLS scope as _one_ session variable (`app.tenant_id`); §"Alternatives considered" rejects expanding the policy template; §"Negative consequences" anticipates only admin-bypass as a future RLS-evolution pressure, not domain-bypass.
- The two-policy split (`tenant_read_policy` + `tenant_write_policy`) is documented (ADR-DB-002 §3 and §"Rationale") as forward-compat for **admin-bypass**, not domain-bypass.

**Architectural cleanliness is preserved.** RLS is not being asked to do domain-separation work it cannot reliably do. There is no risk in this audit's findings of a future "we accidentally use RLS to gate domains" outcome — because the substrate has never made that mistake, and ADR-DB-002 forecloses it.

### D. Phase 2+ recommendations

The substrate is clean. The architectural choice for domains is therefore a _forward_ choice, not a _cleanup_ problem. Three viable shapes; each evidence-cited against Cortex's specific constraints:

#### Path α — **Logical-only** (discriminator column, shared tables)

**Shape:** Add a `domain text NOT NULL CHECK (domain IN ('retail', 'smarthome', 'logistics'))` column to every domain table; index by `(tenant_id, domain, ...)`; queries filter explicitly.

**Pro:**

- Cheapest to ship; no migration of substrate primitives.
- One audit chain across domains per tenant — preserves cross-domain correlation queries.
- Single set of bi-temporal indexes per table.

**Con:**

- Domain becomes a _runtime_ discriminator, easy to forget. Same risk profile as a `WHERE tenant_id` clause in a non-RLS world. Defense-in-depth requires _two_ discriminators per query (tenant + domain).
- Mixed-domain tables don't match how investors, due-diligence reviewers, and partnership lawyers think — _"can you show me all the retail data on its own?"_ requires a query, not a connection-string change.
- Storage-tier decisions become granular: a 500GB IoT telemetry table can't be moved to TimescaleDB without retiring the polymorphic shape.

**When to choose:** if domains turn out to be 80% schema-shared (same audit shape, same temporal shape, same retention) and 20% domain-coupled. If the domains are accidents of taxonomy rather than fundamentally different data shapes.

#### Path β — **Hybrid** (domain-dedicated tables, shared substrate)

**Shape:** Each domain owns its tables (`retail_orders`, `retail_products`, `smarthome_devices`, `smarthome_telemetry`, `logistics_shipments`, `logistics_routes`); all share the same Postgres instance, RLS predicate, audit chain, encryption substrate, blob storage. Tables remain in `public` schema; naming convention carries the domain prefix.

**Pro:**

- Each domain has table-scoped indexes that match its access pattern (IoT time-series indexes, retail business-key indexes, logistics geospatial indexes).
- Storage migrations per-domain are tractable: when smart-home telemetry outgrows OLTP Postgres, only `smarthome_*` tables move (to TimescaleDB or a separate Postgres, with a connection-string switch in the smart-home service).
- Investor / partnership questions answer cleanly: _"all our retail tables are prefixed `retail_`; here's the list."_
- Tenant separation (RLS) still applies — domain separation is _additive_, not _substitutive_.

**Con:**

- Naming-convention discipline is operational — a forgetful migration could drop `retail_` and the violation is invisible to grep until accessed.
- Cross-domain queries (rare, but valuable for ML / aggregate dashboards) require explicit table list.

**When to choose:** if you expect each domain to evolve at a different storage cadence and want to preserve the _option_ to move domains to specialized storage later without a substrate rewrite.

#### Path γ — **Physical** (per-domain Postgres schemas)

**Shape:** `CREATE SCHEMA retail; CREATE TABLE retail.orders ...`; same for `smarthome`, `logistics`. Each schema has its own RLS policies (still tenant-scoped), its own audit chain optionally, its own bi-temporal indexes.

**Pro:**

- Inspector / due-diligence question (_"prove no retail data leaks to smart-home"_) answers via `SET search_path TO retail` — the database denies access to other schemas at the query layer.
- Per-domain Postgres roles can hold `USAGE` on one schema and not others (defense-in-depth at the role level).
- Storage migration is a `pg_dump --schema=retail` export, not a row-by-row filter.

**Con:**

- Bigger upfront commitment. Once `retail.orders` exists, moving a column to `public.shared_orders` is a full migration.
- ADR-DB-002 §"Alternatives considered" rejected per-tenant schemas — but **for tenant-scope reasons** (unbounded count, F02 dynamic provisioning incompatibility). The reasoning _does not transfer_ to domain-scope, where the count is bounded (≤10 verticals) and creation is a deliberate Phase-N event. The ADR-DB-002 rejection should not be read as foreclosing Path γ for domain separation.
- `cortex.current_tenant_id()` and the audit chain have to be coordinated across schemas — tractable, but more careful migration writing.

**When to choose:** if regulatory / partnership / investor scrutiny will repeatedly ask the _"physical proof of separation"_ question and a logical answer is unsatisfying. Smart Home telemetry crosses different regulatory boundaries (EU PSD2 if inferring household behavior; healthcare-adjacent in some jurisdictions) than retail POS data; logistics may carry geospatial PII (driver routes) that retail does not. Stronger separation buys cleaner answers.

#### Recommendation framework

The choice depends on commercial / regulatory pressure, not on engineering preference. To narrow:

1. **If Display Data is the only Phase 1 customer and `dis.golden.roos` is the only retail data path** — Path α is good enough. Single audit chain, retail-flavored events, no operational storage-tier diversity.
2. **If Smart Home or Logistics features land in Phase 2 with non-trivial volume** — Path β is the safer default. Smart Home telemetry on a TimescaleDB instance with `smarthome_*` naming is a one-team migration; on Path α it is a fork.
3. **If a partnership or investor diligence question explicitly asks for physical separation evidence** — Path γ is the only honest answer.

**Default recommendation: Path β (hybrid).** Preserves substrate investment; matches how each domain's data shape will diverge; leaves Path γ open as a future migration if pressure justifies. Avoids the polymorphic-table tax of Path α and avoids the upfront commitment of Path γ.

#### Phase 2+ pre-conditions before the first domain table lands

If any path is chosen, these substrate decisions should accompany the first domain migration (they are deferred today, not blocked):

1. **CHECK constraint on `audit_event.action` namespace.** Today it is free-form `text`. The first domain migration should constrain it to a registered set (`registerAuditActions` enforces TS-side; DB-side is currently unconstrained per `0004_audit_chain.sql:84`).
2. **Audit catalogs per domain.** `@cortex/retail` would own `RETAIL_ORDER_PLACED`, `RETAIL_INVENTORY_UPDATED`, etc., via its own `registerAuditActions(...)` declaration — mirroring `packages/tenant-context/src/audit-actions.ts:18`.
3. **Bi-temporal index recipe extension.** ADR-DB-001 §"Indexing convention" #4 leads on `tenant_id` — first domain table should validate whether `(tenant_id, domain, ...)` or `(domain, tenant_id, ...)` better matches the access pattern, and whether the recipe should be amended.
4. **PostGIS extension activation** (if logistics arrives) — `0001_extensions.sql:28` enables `pgcrypto`, `vector`, `btree_gist`. PostGIS would be a new migration with its own ADR.
5. **Per-domain encryption key namespace** (if a domain has stricter regulatory requirements). ADR-INFRA-004 / ADR-INFRA-007 are silent on per-domain keys; the substrate could accommodate them by extending `tenant_kms_key` with a `key_purpose text` column or by introducing `tenant_domain_kms_key`. Defer until forced by a real requirement.
6. **Audit chain per domain or shared** — ADR-DB-003's chain is per-tenant. A future ADR (call it ADR-DB-004) would need to address whether smart-home and retail events share one chain (Path α / β default) or two chains (Path γ default).

---

## File reference map

For future re-audit or due-diligence handoff, the evidence-bearing locations:

| Concern                            | File / line                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Migration journal                  | `services/foundation/migrations/meta/_journal.json`                                         |
| Migration sources                  | `services/foundation/migrations/0001_extensions.sql` … `0010_tenant_lifecycle_metadata.sql` |
| Drizzle schema                     | `packages/canonical-schema/src/drizzle/schema.ts`                                           |
| RLS reader function                | `services/foundation/migrations/0003_rls_baseline.sql`                                      |
| Audit chain DDL + trigger          | `services/foundation/migrations/0004_audit_chain.sql`                                       |
| Control plane DDL                  | `services/foundation/migrations/0007_control_plane_tables.sql`                              |
| F02 lifecycle metadata             | `services/foundation/migrations/0010_tenant_lifecycle_metadata.sql`                         |
| Tenant-scoped Drizzle queries      | `packages/tenant-context/src/{tenants,provisioning-worker}.ts`                              |
| Per-tenant CMEK resolver           | `packages/secrets/src/per-tenant-keys.ts:59`                                                |
| Compute placement (tier→shape)     | `packages/compute-placement/src/get-placement.ts:74`                                        |
| Quota config (per-tenant override) | `packages/quotas/src/config.ts:65`                                                          |
| Audit action catalog (tenant)      | `packages/tenant-context/src/audit-actions.ts:18`                                           |
| RLS contract ADR                   | `docs/architecture/decisions/ADR-DB-002-row-level-security.md`                              |
| Bi-temporal model ADR              | `docs/architecture/decisions/ADR-DB-001-bi-temporal-data-model.md`                          |
| Audit chain ADR                    | `docs/architecture/decisions/ADR-DB-003-audit-event-sha-chain.md`                           |
| Per-tenant CMEK migration ADR      | `docs/architecture/decisions/ADR-INFRA-007-per-tenant-cmek-migration-path.md`               |
| ROOS external boundary ADR         | `docs/architecture/decisions/ADR-SCOPE-009-roos-external.md`                                |
| Compute isolation ADR              | `docs/architecture/decisions/ADR-COMPUTE-001-cloud-run-vs-k8s-compute-isolation.md`         |
| Tenant lifecycle ADR               | `docs/architecture/decisions/ADR-LIFECYCLE-001-state-machine-and-cloud-tasks.md`            |
| MCP positioning ADR                | `docs/architecture/decisions/ADR-MCP-001-cortex-is-mcp-native.md`                           |
| GCS bucket TF                      | `infra/terraform/modules/tenant-data-bucket/main.tf`                                        |
| Cloud Tasks queue TF               | `infra/terraform/modules/cloud-tasks-queue/main.tf`                                         |

---

## Verdict

- **Tenant separation:** Strong, four-layer (DB RLS, AAD-bound encryption, GCS path validators, Enterprise per-tenant Cloud Run). No findings.
- **Domain separation:** **Pre-domain.** No vertical-specific schema, code, or storage exists today. The architectural decision is open and unconstrained by the substrate.
- **RLS misuse for domain separation:** **No.** Every policy is tenant-scoped; no domain predicate exists; ADR-DB-002 forecloses misuse by design.
- **Recommended Phase 2+ default:** **Path β (hybrid)** — domain-prefixed tables on shared substrate. Preserves substrate investment; leaves Path γ open if regulatory or commercial pressure justifies physical separation later.

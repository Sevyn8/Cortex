# Cortex Build Prompts for Claude Code — v3.1 Consolidated

**Companion document to:** Sevyn8 Cortex Complete System Specification v2.2
**Scope:** Every prompt needed to build Cortex, ordered by execution sequence
**Audience:** Seema + engineering team driving Claude Code sessions
**Status:** CONFIDENTIAL — Sevyn8 Private Limited
**Version:** 3.1 (v3.0 + P0.8 expanded for protocol-agnostic tool platform per ADR-MCP-001)

---

## What's new in v3.1 vs v3.0

- **P0.8 (MCP server scaffolding) expanded from ~30 lines to a full tool-platform scaffold.** The v3.0 P0.8 was a minimal three-server skeleton; v3.1 reflects the decision in ADR-MCP-001 that Cortex is MCP-native with a protocol-agnostic tool platform. The expanded prompt adds capability-layer packages (`@cortex/cortex-tools-{core,edge,admin,shared}`), the shared tool registry (`@cortex/tool-registry`), and per-server trust-model ADR stubs (ADR-MCP-002/003/004). Tool implementations live in packages; MCP servers are thin adapters. Protocol migration, should MCP be superseded, is bounded to the adapter layer.
- **Spec companion updated to v2.2** to close the "Case for MCP" section reference. ADR-MCP-001 is the decision of record; spec §Part VII-b summarizes it; this prompts file references both.
- **No changes to any other prompt.** P0.1 through P0.7, P0.9, P0.10, and all of P1 through P15 are untouched. If you already ran P0.1–P0.7 on v3.0, v3.1 is a drop-in replacement that affects only what you run at P0.8.

## What's new in v3 vs v2

- **ADR-SCOPE-009 baked in: ROOS remains external to Cortex.** Ithina continues operating ROOS; Cortex consumes `dis.golden.roos` as an upstream source. Cortex builds zero POS-specific connectors. Cortex agents are complementary to Ithina's existing ROOS agents, not replacements.
- **ADR-INFRA-001 baked in: Pub/Sub internal, Kafka at edges.** Internal event backbone stays Pub/Sub for operational simplicity and GCP-native integrations. Kafka is first-class at integration boundaries (ROOS being the flagship). A `@cortex/event-bus` abstraction package isolates the internal bus choice so it's swappable later.
- **P4.4 (G01 Universal Ingestion Gateway) expanded significantly.** Was ~20 lines; now ~180 lines. Kafka elevated from "one of many connectors" to first-class with full connection, schema, backpressure, failure-handling, multi-tenancy requirements. ROOS connector specified as flagship implementation with strict boundary enforcement. Fallback plan for context-window splits (P4.4a/b/c/d) included.
- **Appendix D updated** with two new ADR rows capturing these scope and infrastructure decisions.

Everything else — prompt ordering, meta-prompts, P0 through P3, P5 through P15 — unchanged from v2. If you already had v2 in your hands, v3 is a drop-in replacement that fixes the ingestion-layer thinking without rewriting the rest.

## What's new in v2 vs v1 (preserved from v2 front matter)

- **Added 14 new prompts** (marked NEW in v2) covering gaps identified in review: Super Admin bootstrap, audit event convention, feature flags, RE01, retail vertical package content, Display Data extension package, error format, email templates, minimal SCR-24 for Phase 1, Model Registry Light, CSV Ingestion Agent integration, backup restoration drill, expanded T01, frontend quality gates.
- **Amended existing prompts:** P0.1 (full CLAUDE.md content), P4.3 (deferred to Phase 2), P6.2 (Storybook integrated), P11.1 (default seeds), P15.2 (expanded to full T01).
- **Baked in architectural decisions** (see "Architectural decisions" section below). No more TBDs on auth provider, ORM, monorepo tool, etc.
- **Renumbered:** W01 moved to P8.14 (minimal SCR-24 inserted as P8.13); Model Registry Light inserted as P10.1a; P15 series renumbered to accommodate new FE quality gates prompt.
- **Total Phase 1 prompts: ~100** (up from ~91 in v1).

---

## How to use this document

1. **Execute in order.** Prompts are ordered by dependency. Don't skip ahead — later prompts assume earlier ones are done.
2. **One prompt = one Claude Code session.** Each prompt is scoped to roughly 1–3 hours of focused Claude Code work. Don't combine them.
3. **Start every session with the kickoff meta-prompt** (§M1 below). It re-anchors Claude Code on the repo, the spec, and current progress.
4. **End every session with the wrap-up meta-prompt** (§M2). It commits code, updates the progress tracker, and leaves clean handoff notes.
5. **Keep `/docs/spec/cortex_v2.docx` in the repo root.** Most prompts reference a specific section. Claude Code reads it directly.
6. **Keep `/docs/skills/sevyn8-workflow/SKILL.md` in the repo.** Any prompt generating customer-facing or brand-adjacent content follows this.
7. **Commit after every prompt.** One prompt = one (or a few) atomic commits. Never leave uncommitted work across sessions.
8. **Progress tracker lives at `/docs/progress/status.md`.** After each session, Claude Code updates which prompt IDs are complete, in-progress, blocked.

---

# Pre-flight checklist

Work through this list BEFORE pasting M1 into Claude Code. Every box ticked = you're ready.

### Account & tooling

- [ ] Claude Code installed and logged in (`claude --version` works)
- [ ] Paid Claude plan active (Pro or Max) — Claude Code is not on free tier
- [ ] GitHub org `sevyn8` set up with branch protection rules drafted
- [ ] Repository `sevyn8/cortex` created (private)

### Repo prerequisites

- [ ] v2 spec docx at `/docs/spec/cortex_v2.docx`
- [ ] Sevyn8 skill at `/docs/skills/sevyn8-workflow/SKILL.md`
- [ ] This prompts file at `/docs/build-prompts/cortex_build_prompts_v3.md`
- [ ] Empty progress tracker at `/docs/progress/status.md` (template in Appendix C)

### GCP foundations

- [ ] GCP organization set up (not personal Google account)
- [ ] Billing account attached, spending alerts configured
- [ ] Projects planned: cortex-dev, cortex-staging, cortex-production
- [ ] Region decided: asia-south1 primary, asia-south2 DR

### Third-party providers

- [ ] WorkOS account created (or accept deferred setup for Week 4)
- [ ] Anthropic API key procured for A05 LLM Gateway usage
- [ ] Email provider chosen (Resend recommended for Phase 1)
- [ ] Artifact storage plan — Google Artifact Registry (same GCP project)

### Architectural decisions — confirm defaults below

- [ ] Decisions reviewed and defaults accepted (see next section)
- [ ] Deviations from defaults captured in ADR before P0.1

### Display Data coordination

- [ ] Ithina named contact for HHT app integration
- [ ] Ithina named contact for POS file format + access
- [ ] Training data plan for YOLO fine-tune (access, labeling quality, quantity)
- [ ] Downstream Ithina retail client(s) named for initial workspaces
- [ ] Display Data custom domain chosen (e.g., insights.ithina.com)

### Legal / compliance

- [ ] DPA between Sevyn8 and Display Data drafted (can sign during build, MUST sign before production)
- [ ] Sub-processor list at T-0 documented (GCP, Anthropic, WorkOS, Resend, etc.)
- [ ] DPDP compliance posture documented

Once every box is ticked, paste M1 into Claude Code, then P0.1.

---

# Architectural decisions — baked defaults

The v1 prompts left several choices open ("Auth0 or WorkOS"). This v2 bakes in specific defaults. Deviate only with an ADR capturing why.

### Stack

| Decision             | Default                                                  | Rationale                                                                         |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Auth provider**    | WorkOS                                                   | B2B multi-tenant focus; Enterprise SSO first-class; simpler DX than Auth0         |
| **Monorepo tool**    | Turborepo                                                | Faster, less ceremony; re-evaluate Nx at Phase 2 if repo complexity grows         |
| **ORM**              | Drizzle                                                  | TypeScript-first, bi-temporal column friendly, avoids Prisma's migration friction |
| **CSS framework**    | Tailwind 4                                               | Pin to v4.x; use CSS vars exclusively for tenant theming                          |
| **Migration tool**   | drizzle-kit                                              | TypeScript-native; co-located with ORM                                            |
| **RSC strategy**     | Server-rendered app shell; Client Components for screens | Admin screens are interactive; analytical screens mix of both                     |
| **Frontend testing** | Vitest + RTL + Playwright + axe-core + Lighthouse CI     | See P15.4                                                                         |

### Scope

| Decision                                 | Phase 1                                | Phase 2+                                            |
| ---------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| **I03 Multi-Source Conflict Resolution** | Deferred                               | Phase 2 (Body Shop drives demand)                   |
| **I02 Knowledge Graph**                  | Phase 1 cut (Postgres recursive CTEs)  | Full graph DB Phase 3                               |
| **ED01 Edge-Cloud Orchestrator**         | Deferred                               | Phase 2 (no edge devices in Display Data Phase 1)   |
| **Mobile UX**                            | Tablet responsiveness (768px+)         | Mobile phone (375-767px) Phase 2                    |
| **Workspace isolation**                  | Strict data isolation                  | Tenant Admin aggregate rollup for billing/ops only  |
| **Dashboard Builder UI**                 | Parked                                 | Phase 3; Sevyn8 authors all dashboards in Phase 1-2 |
| **SCR-24 Platform Ops**                  | Minimal cut (provisioning wizard only) | Full capability Phase 2                             |

### Non-functional targets

| Target                     | Value                              |
| -------------------------- | ---------------------------------- |
| **Enterprise tier RPO**    | 1 hour                             |
| **Enterprise tier RTO**    | 2 hours                            |
| **Authz decision p99**     | < 5ms cached                       |
| **Alert rule propagation** | < 30s                              |
| **Unit test coverage**     | 80% line / 70% branch              |
| **Accessibility**          | WCAG 2.1 AA on every screen        |
| **Performance budget**     | LCP < 2.5s, TBT < 300ms, CLS < 0.1 |

---

# META-PROMPTS

These are not build prompts — they're session-management prompts you reuse across every actual build session.

## M1: Session Kickoff (paste first in every new Claude Code session)

```
You are continuing work on Cortex — Sevyn8's edge AI and retail intelligence platform.

Before doing anything else:
1. Read /docs/spec/cortex_v2.docx if you haven't already in this session. It is the master specification — 167 pages, 61 backend modules, 24 admin console screens, 11 analytical screens, 1 onboarding wizard. Module IDs follow patterns: F0x (Foundation), D0x (Data Platform), I0x (Identity), G0x (Ingestion), AC0x (Access Control), S0x (Streaming — NOT admin screens), IC0x (Industry), A0x (Algorithms), E0x (Embeddings), O0x (Orchestration), OB0x (Observability), PR0x (Privacy), ED0x (Edge), FB0x (Feedback), UX01 (Screen Composition), SCR-0x (Admin Console screens 01–24), CX-0x (Analytical screens), W01 (Onboarding Wizard). IMPORTANT: "S01" and "S02" in the spec are backend modules (Stream Processing, Cross-Modal Correlation), NOT admin screens. Admin screens are prefixed SCR-.

2. Read /docs/skills/sevyn8-workflow/SKILL.md. This governs voice, tone, terminology, and branding for any user-visible text you generate (UI copy, docs, error messages).

3. Read /docs/progress/status.md to see what is complete, in progress, or blocked.

4. Read /docs/architecture/decisions/ for any Architecture Decision Records that constrain your current task.

5. If a `CLAUDE.md` file exists at the repo root, read it — it contains repo-specific conventions.

Now: I will give you a specific prompt ID to execute. When you receive it, re-read the spec section it references before writing any code. Think before coding. Ask clarifying questions if the prompt is ambiguous — don't guess at architectural decisions that aren't explicit.

Confirm you're ready, then wait for my prompt ID.
```

## M2: Session Wrap-up (paste at end of every session)

```
We're ending this Claude Code session. Before we wrap:

1. Run all tests. Fix anything failing.
2. Run the linter and type-checker. Fix anything failing.
3. Commit all changes. Use conventional commit format: `feat(module): short description` or `fix(module): short description` or `docs(module): ...`. Include the prompt ID in the commit body.
4. Update /docs/progress/status.md: move the current prompt ID to the appropriate section (Complete, In Progress, Blocked). If blocked, note why.
5. Update /docs/architecture/decisions/ with an ADR for any significant architectural decision made this session.
6. Write a short handoff note at /docs/progress/handoff-[YYYY-MM-DD].md summarizing: what was built, what's left, any surprises, any follow-up prompts recommended.
7. Push the branch.

Do not fabricate progress. If something isn't working, say so.
```

## M3: Spec Lookup (use when you need Claude Code to quote/summarize spec)

```
Before you write any code, read /docs/spec/cortex_v2.docx sections [SECTION IDs]. Quote the specific Functional Requirements you will implement. If the spec is ambiguous or incomplete for what I've asked, list the gaps before proceeding.
```

## M4: Code Review (use between sessions to verify quality)

```
Review the code written in the last session (run `git log --oneline -20` to find commits). For each changed file:
- Does it match what the spec says?
- Are there missing acceptance criteria from the spec that the code doesn't yet satisfy?
- Is the code following the patterns established in earlier modules (check neighboring files)?
- Are tests comprehensive, or are edge cases missing?
- Is there any dead code, stubs, or TODOs that need resolving before we move forward?

Produce a review note at /docs/progress/review-[YYYY-MM-DD].md. Flag anything blocking.
```

## M5: Regression Fix (use when something breaks after a change)

```
Something regressed. Before fixing anything:
1. Run the failing tests. Paste the exact error output.
2. Identify the commit that introduced the regression (git bisect if needed).
3. Explain the root cause in plain terms before writing a fix.
4. Propose the minimum change that fixes it.
5. Add a regression test that would have caught this.
6. Only then apply the fix.

Do not rewrite surrounding code while fixing. Keep the fix minimal.
```

---

# PART 0: FOUNDATION — REPO, INFRASTRUCTURE, TOOLING

**Timing:** Week 1–2. Must complete before any module code is written.

---

## P0.1: Initialize Cortex monorepo

**Spec reference:** §"Document Structure", Design Parameters
**Dependencies:** None
**Output:** Empty but fully-configured monorepo

```
Initialize a fresh monorepo for Cortex, Sevyn8's edge AI and retail intelligence platform. This will be the single source of truth for all 61 backend modules, 24 admin screens, 11 analytical screens, 1 wizard, and supporting infrastructure.

Structure:
/apps
  /admin-console       — Next.js 15, App Router (SCR-01 through SCR-24, W01)
  /analytical          — Next.js 15, App Router (CX-01 through CX-DD-01)
  /api-gateway         — Node + Fastify, fronted by O01
  /mcp-cortex-core     — MCP server: data plane operations
  /mcp-edge            — MCP server: edge device operations
  /mcp-admin-ops       — MCP server: admin/ops operations
  /agents              — One subdir per Ithina agent (planogram, pac, promotion, perishable)
  /dis-worker          — Data Ingestion Service workers (G01-G06)

/packages
  /widgets             — UX01 Widget Library (React components)
  /design-system       — Tailwind config, CSS vars, tokens, typography
  /api-client          — Generated tRPC/OpenAPI client
  /canonical-schema    — D01 canonical entity types (TypeScript + Zod)
  /auth                — AC01 client helpers
  /tenant-context      — F01 tenant context provider
  /cortex-sdk          — Public SDK (Phase 2+, scaffold now)

/services              — Backend modules grouped by layer
  /foundation          — F01–F05
  /data-platform       — D01–D06
  /identity            — I01–I03
  /ingestion           — G01–G06
  /access              — AC01–AC04
  /streaming           — S01
  /industry            — IC01–IC02
  /ai                  — A01–A08, E01–E02
  /orchestration       — O01–O04
  /observability       — OB01–OB03
  /privacy             — PR01–PR06
  /edge                — ED01–ED03
  /feedback            — FB01–FB03
  /resilience          — RE01
  /testing             — T01

/infra
  /terraform           — GCP infrastructure as code
  /k8s                 — GKE Autopilot manifests
  /ci                  — GitHub Actions workflows

/docs
  /spec                — cortex_v2.docx lives here
  /skills              — sevyn8-workflow skill files
  /architecture        — Architecture Decision Records
  /progress            — Build progress tracker
  /runbooks            — Operational runbooks

/scripts               — Dev tooling, database migrations, codegen

Setup:
- pnpm workspace with workspace.yaml
- TypeScript 5.x strict mode across all packages
- Turborepo or Nx for task orchestration
- Shared tsconfig.base.json at root
- ESLint + Prettier + lint-staged + Husky
- Conventional commits enforced via commitlint
- Node 22 LTS
- .nvmrc, .node-version, .tool-versions
- README at root explaining the monorepo
- CLAUDE.md at root — use the full content in the "CLAUDE.md content" section below. This is the source of truth for all code conventions.
- CONTRIBUTING.md
- LICENSE (TBD placeholder — "PROPRIETARY, Sevyn8 Private Limited, all rights reserved")

Do not yet create any service code, UI code, or infrastructure. Only the skeleton + tooling. Verify everything builds and lints cleanly with empty packages.

Acceptance:
- `pnpm install` succeeds at root
- `pnpm -r typecheck` passes on empty packages
- `pnpm -r lint` passes
- CLAUDE.md at repo root contains every section from the "CLAUDE.md content" block below
- Commit as `feat(repo): initialize cortex monorepo skeleton`
```

### CLAUDE.md content (required at repo root)

The following must be the content of `/CLAUDE.md` after P0.1 completes:

```markdown
# Cortex — Claude Code instructions

## Spec-first workflow

- Read `/docs/spec/cortex_v2.docx` before implementing any module or screen
- Every functional requirement (FR-NNN) in a spec section has at least one test
- Spec drift: update the spec OR update the code, never leave drift uncommented
- Significant divergence → ADR in `/docs/architecture/decisions/`

## Coding conventions

- TypeScript strict. No implicit any. No @ts-ignore without ADR reference.
- Functions < 40 lines; files < 400 lines (soft limits — flag violations in PR review)
- No business logic in controllers/routes. Thin HTTP handlers → service layer → repository
- Zod schemas for every API input and output
- No `console.log`; use `@cortex/observability` logger

## Commit conventions

- Conventional commits. Types: feat, fix, docs, refactor, test, chore, ops
- Scope = module ID (lowercase): `feat(f01): ...`
- Include prompt ID in commit body: `Prompt: P1.1`
- Reference spec section: `Spec: §F01-FR-003`

## Branching & PR

- Trunk-based. Main is always deployable
- Short-lived branches: `{prompt-id}-{short-desc}` (e.g., `p1.1-f01-multi-tenancy`)
- PR required to merge to main. At least one human review for non-trivial PRs
- Solo dev OK to self-review, but use M4 Code Review meta-prompt between sessions

## Audit events

- Follow `/docs/architecture/audit-event-convention.md`
- Every mutating service method emits an audit event via `@cortex/audit-events`

## Error responses

- Standard shape: `{ code, message, correlation_id, details? }`
- HTTP status alignment: 400 VALIDATION, 401 UNAUTH, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT, 422 BUSINESS_RULE, 429 RATE_LIMIT, 500 INTERNAL
- Use `@cortex/http-errors` package

## Testing

- Unit test coverage: 80% line / 70% branch minimum
- Every acceptance criterion from spec → at least one test
- Regression tests required for bug fixes
- Every widget and screen passes axe-core (WCAG 2.1 AA)

## Stack constraints

- Auth: WorkOS (not Auth0, not self-hosted)
- ORM: Drizzle (not Prisma, not raw pg)
- Monorepo: Turborepo (not Nx)
- CSS: Tailwind 4 with CSS vars for theming
- Node: 22 LTS
- Package manager: pnpm

## Feature flags

- All new capabilities roll out behind a feature flag (`@cortex/feature-flags`)
- Flags tracked in F04; retire within 6 months of stability
```

---

## P0.2: Development environment & local tooling

**Spec reference:** Design Parameters
**Dependencies:** P0.1
**Output:** docker-compose dev stack, Makefile/scripts, onboarding docs

```
Build the local development environment so any engineer can `make dev` and have Postgres, Pub/Sub emulator, and GCS emulator running locally in under 2 minutes.

Create:
1. /infra/dev/docker-compose.yml with:
   - Postgres 15 with pgvector extension enabled, bi-temporal helper schema pre-loaded
   - Pub/Sub emulator (google/cloud-sdk image)
   - Fake GCS server for blob storage
   - Redis for local caching and online feature store
   - Adminer for Postgres inspection
   All services on named volumes so data persists across restarts.

2. /scripts/dev/ with:
   - start.sh — docker-compose up + seed baseline data
   - stop.sh — docker-compose down
   - reset.sh — full wipe + reseed
   - seed-demo-tenant.sh — creates a 'demo-tenant' with minimal D01 data for testing

3. /Makefile at root with targets: dev, stop, reset, test, lint, typecheck, format, build, clean

4. .env.example at root listing every env var needed (DB URLs, Pub/Sub project, GCS bucket paths, LLM API keys for A05, etc.) with safe placeholder values.

5. /docs/onboarding.md — a single file a new engineer reads to get productive.

The seed demo tenant must produce a coherent minimal dataset sufficient to exercise CX-01 Executive Dashboard once built: 5 stores, 200 products, 1000 transactions over 30 days, 50 customers. Data should be internally consistent (referential integrity).

Acceptance:
- `make dev` brings up the stack in under 2 minutes on a fresh machine
- `make reset && make dev` returns to a known-good state deterministically
- Running `psql` against the local Postgres lets me query the demo-tenant's retail.Transaction table and see 1000 rows
- Commit as `feat(dev-env): local dev stack + seed tooling`
```

---

## P0.3: GCP infrastructure baseline (Terraform)

**Spec reference:** §Design Decisions — Primary Cloud = GCP, asia-south1 primary
**Dependencies:** GCP org + billing set up out-of-band
**Output:** Terraform IaC for GCP foundations

```
Author Terraform for the GCP foundation. Keep environments separate — dev, staging, production — with dev as the first to come up.

/infra/terraform/
  /modules
    /project           — GCP project + API enablement
    /vpc               — VPC, subnets, firewall rules, PSC for managed services
    /iam               — service accounts, workload identity, IAM bindings
    /cloud-sql         — Postgres 15 with pgvector, customer-managed encryption (CMEK)
    /bigquery          — Datasets with partitioning and clustering defaults
    /gcs               — Buckets (tenant-prefixed structure), lifecycle policies
    /pubsub            — Baseline topics (see below)
    /secret-manager    — Secret Manager + rotation config
    /kms               — Key rings + keys for CMEK, envelope encryption
    /gke               — GKE Autopilot cluster with Workload Identity
    /cloud-run         — Cloud Run service template
    /eventarc          — Eventarc subscriptions for G01 triggers
    /artifact-registry — Docker + npm artifact registries
    /cloud-build       — CI/CD trigger config
    /observability     — Cloud Ops metrics scope, log sinks, uptime checks

  /envs
    /dev
    /staging
    /production

Baseline Pub/Sub topics to provision (one per tenant pattern, with tenant prefix via subscription filters):
- ingest.raw           — G01 landing
- ingest.canonical     — G02 output after mapping
- quality.events       — D04 rule evaluations
- decisions.emitted    — A03 decision pipeline output
- actions.dispatched   — O04 action events
- consent.changes      — AC03 consent state changes
- audit.events         — S20 audit feed
- alerts               — O02 alert engine

GCS bucket structure:
- cortex-{env}-bronze       — Bronze tier raw data (tenant-prefixed paths)
- cortex-{env}-silver       — Silver tier validated data
- cortex-{env}-gold         — Gold tier enriched/resolved (mostly BigQuery, some GCS)
- cortex-{env}-artifacts    — Build artifacts, ML models, agent outputs
- cortex-{env}-backups      — Automated backups

Region: asia-south1 primary, asia-south2 DR. Dev can be single-region.

Wire Terraform state to a GCS backend bucket, not local state.

Include a /infra/terraform/README.md explaining the plan/apply workflow and the environment promotion process.

Acceptance:
- `terraform plan` for dev passes with clean output (no errors)
- `terraform apply` for dev provisions cleanly, then `terraform destroy` cleans up
- GCS state is configured
- Commit as `feat(infra): gcp terraform foundation (dev/staging/prod)`
```

---

## P0.4: Database baseline — Postgres + bi-temporal helpers

**Spec reference:** F03 Temporal Data Engine, F01 §1.4
**Dependencies:** P0.3
**Output:** Migration framework + bi-temporal helpers + RLS scaffolding

```
Set up the Postgres migration framework and the cross-cutting database helpers every module will rely on.

Use sqitch OR golang-migrate OR drizzle-kit — pick one and justify the choice in an ADR at /docs/architecture/decisions/ADR-002-database-migration-tool.md. Recommendation: drizzle-kit for TypeScript-first integration, sqitch for deploy-safety and dependency graphs. Make the call and document.

Create the following cross-cutting schema elements — these are reused by every subsequent module migration:

1. /services/foundation/migrations/0001_bi_temporal_helpers.sql
   - Custom types: tstzrange wrappers for valid-time and transaction-time
   - Trigger functions for automatic transaction-time maintenance
   - Helper functions: temporal_union, temporal_intersection, at_time_t
   - Indexes: every tenant-scoped table will need (tenant_id, valid_from, valid_to) and (tenant_id, txn_from, txn_to) btree/gist indexes

2. /services/foundation/migrations/0002_rls_baseline.sql
   - Base policy template function for tenant_id scoping
   - current_tenant_id() function reading session variable set by F01 middleware
   - Policy templates: read-by-tenant, write-by-tenant, admin-bypass

3. /services/foundation/migrations/0003_audit_baseline.sql
   - audit_event table (SHA-chained — see SCR-20-FR-009)
   - Trigger helpers for generic audit on any table

4. /services/foundation/migrations/0004_pgvector.sql
   - Enable pgvector extension
   - Helper functions for embedding similarity search

5. /packages/canonical-schema/src/temporal.ts — TypeScript types for tstzrange, bi-temporal envelope

Do NOT yet create any D01 tables. Only the cross-cutting infrastructure.

Acceptance:
- `make db-migrate` runs cleanly against dev Postgres
- Unit test: insert a row, update it, query it "as of" a prior timestamp — returns the old value
- RLS policy test: set session tenant_id to A, try to read tenant B's row — returns zero rows
- Commit as `feat(foundation): postgres bi-temporal + RLS baseline`
```

---

## P0.5: CI/CD pipeline

**Spec reference:** T01 Platform Testing Framework
**Dependencies:** P0.1, P0.3
**Output:** GitHub Actions workflows + Cloud Build integration

```
Set up CI/CD that runs on every PR and produces deployable artifacts on main.

/.github/workflows/
  ci.yaml              — PR checks: lint, typecheck, unit tests, integration tests
  build.yaml           — On main: build container images, push to Artifact Registry
  deploy-dev.yaml      — On main: auto-deploy to dev environment
  deploy-staging.yaml  — Manual trigger: deploy to staging
  deploy-production.yaml — Manual trigger + required approvals: deploy to production

Stages in ci.yaml:
1. Checkout
2. Setup pnpm + Node
3. Install (cached)
4. Lint all packages
5. Typecheck all packages
6. Unit test all packages (parallel)
7. Build all packages
8. Spin up ephemeral Postgres, run integration tests
9. Security scan (Snyk or GitHub Advanced Security)
10. License scan

Quality gates: PR cannot merge unless every stage passes. Enforce via branch protection rules on main.

Container build pattern: multi-stage Dockerfile per service (/services/*/Dockerfile). Base images: node:22-slim for JS services, debian:bookworm-slim for runtime. Distroless preferred where feasible.

Image tagging: {service}:{git-sha} and {service}:{env}-latest. Never :latest.

Deploy-dev should be fully automatic on green main. Deploy-staging requires manual approval via GitHub environment protection rules. Deploy-production requires two-person approval and happens only during defined release windows.

Rollback: every deploy saves the previous image tag so `make rollback-{env}` reverts in under 60 seconds.

Acceptance:
- Open a PR, CI runs full pipeline green
- Merge to main, dev deploys automatically
- Triggering staging deploy requires my manual approval
- Commit as `feat(ci): github actions + cloud build pipelines`
```

---

## P0.6: Observability baseline

**Spec reference:** OB01 Platform Observability Stack
**Dependencies:** P0.3
**Output:** Logging, metrics, tracing baseline

```
Establish the observability baseline every service will inherit. Build this as a /packages/observability package that every service imports.

Capabilities:
1. Structured logging via pino, with automatic injection of:
   - tenant_id (from F01 context)
   - user_id (from AC01 context)
   - request_id (from incoming HTTP/gRPC/Pub/Sub)
   - trace_id / span_id (from OpenTelemetry)
   - module_id (service constant)
2. OpenTelemetry SDK configured to export to Google Cloud Trace
3. Prometheus-compatible metrics via prom-client, auto-scraped by GKE
4. Standard metrics every service emits: request_count, request_duration_ms histogram, error_count, dependency_latency, queue_depth (for event-driven services)
5. Cloud Logging + Cloud Monitoring integration — logs structured as JSON so Cloud Logging parses them natively
6. Error reporting: unhandled exceptions auto-reported to Cloud Error Reporting

/packages/observability/src/
  logger.ts
  tracer.ts
  metrics.ts
  http-middleware.ts — auto-instruments Express/Fastify
  grpc-middleware.ts
  pubsub-wrapper.ts  — auto-traces Pub/Sub handlers
  index.ts — export everything

Include helper /scripts/observability/smoke-test.ts that spins up a tiny test service, emits a log, a trace, and a metric, then confirms all three reached Cloud Ops.

Acceptance:
- Any new service can import { logger, tracer, metrics } and get full observability in one line
- Logs in Cloud Logging are filterable by tenant_id, module_id, request_id, trace_id
- A distributed trace across two services shows up in Cloud Trace
- Commit as `feat(observability): unified logging/metrics/tracing baseline`
```

---

## P0.7: Secret Manager + KMS wiring

**Spec reference:** F01 §1.2.4 Encryption & Key Management
**Dependencies:** P0.3
**Output:** Per-tenant KMS key helpers + Secret Manager access patterns

````
Wire Secret Manager and KMS into the monorepo so services can retrieve secrets safely.

/packages/secrets/
  src/
    secret-manager.ts  — get/put/rotate
    kms.ts             — envelope encryption helpers
    per-tenant-keys.ts — F01 §1.2.4 per-tenant KMS key retrieval and usage
    index.ts

Patterns:
- Secrets never in env vars in production. Dev uses .env.local; staging/prod use Secret Manager via Workload Identity.
- Every tenant gets a dedicated KMS key at provisioning (via F02). The packages/secrets module exposes getKeyForTenant(tenantId).
- Envelope encryption helper: encrypt(tenantId, plaintext) → ciphertext, decrypt(tenantId, ciphertext) → plaintext. DEK generated per-operation, wrapped with the tenant's KMS key.
- Audit every access — structured log with tenant_id, key_id, operation, actor.

Caller pattern:
```typescript
import { secrets, envelope } from '@cortex/secrets';
const apiKey = await secrets.get('sendgrid-api-key', { tenantId });
const encrypted = await envelope.encrypt(tenantId, plaintext);
````

Do NOT implement secret rotation logic yet — that's part of F02. Just the retrieval and envelope encryption.

Acceptance:

- Unit tests with a mocked KMS client verify envelope encrypt/decrypt round-trips
- Integration test against dev GCP KMS confirms real keys work
- Commit as `feat(secrets): secret-manager + per-tenant kms helpers`

```

---

## P0.8: MCP server scaffolding + protocol-agnostic tool platform (EXPANDED in v3.1)

**Spec reference:** §Part VII-b "The Case for MCP" (Cortex v2.2), UX01 note on MCP-native architecture
**ADR reference:** ADR-MCP-001 (Cortex is MCP-Native — Three-Server Decomposition with Protocol-Agnostic Tool Platform) — **MUST READ before executing this prompt**
**Dependencies:** P0.1 (monorepo), P0.6 (observability), P0.7 (secrets)
**Output:** Three MCP server skeletons + four capability-layer packages + shared tool registry + three per-server trust-model ADR stubs, no tools yet

```

Scaffold the MCP integration layer for Cortex per ADR-MCP-001. This is a protocol-agnostic tool platform that exposes capabilities over MCP today; MCP is the adapter, not the architecture. Before writing any code, read ADR-MCP-001 in full — the implementation pattern diagram is authoritative. Also re-read spec §Part VII-b in /docs/spec/cortex_v2.docx.

Scope has four parts: (A) capability-layer packages, (B) shared tool registry, (C) three MCP server apps, (D) per-server trust-model ADR stubs. All four land in the same prompt execution because they form a coherent system.

## Part A: Capability-layer packages

Four new packages under /packages/ holding tool implementations and shared helpers. All tools live here, not in the servers.

/packages/cortex-tools-core/ @cortex/cortex-tools-core

- Tools exposed by mcp-cortex-core (tenant-scoped operations)
- Empty shell at P0.8; modules register their tools here as they land

/packages/cortex-tools-edge/ @cortex/cortex-tools-edge

- Tools exposed by mcp-edge (edge zone operations)
- Empty shell at P0.8; S15 and edge modules register tools here

/packages/cortex-tools-admin/ @cortex/cortex-tools-admin

- Tools exposed by mcp-admin-ops (Sevyn8-only cross-tenant operations)
- Empty shell at P0.8; admin/ops modules register tools here

/packages/cortex-tools-shared/ @cortex/cortex-tools-shared

- Shared helpers: auth middleware abstractions, audit emitters, tool-schema base types, tenant-context extractors
- Non-empty at P0.8: contains the tool definition base types (see below)

Each capability-layer package:

- TypeScript, strict mode (inherits tsconfig.base.json)
- Zod as the schema library (matches rest of repo)
- Exports tool definitions with the @cortex/tool-registry type `ToolDefinition<TInput, TOutput>`
- Depends on @cortex/observability (logging), @cortex/tenant-context (request scoping), @cortex/audit-events (audit emission — stub package allowed if not yet built)

## Part B: Shared tool registry

One new package:

/packages/tool-registry/ @cortex/tool-registry

This package defines:

1. `ToolDefinition<TInput, TOutput>` — the canonical tool shape:
   {
   name: string, // e.g., "query-canonical-entity"
   description: string, // for agent discovery
   inputSchema: ZodType<TInput>,
   outputSchema: ZodType<TOutput>,
   servers: Array<'mcp-cortex-core' | 'mcp-edge' | 'mcp-admin-ops'>,
   auth: Record<ServerName, AuthProfile>,
   implementation: (input: TInput, ctx: ToolContext) => Promise<TOutput>,
   audit: { category: 'read' | 'write' | 'admin', severity: 'info' | 'warn' | 'error' },
   }

2. `ToolRegistry` class with:
   - `register(tool: ToolDefinition): void` — modules call this at initialization
   - `toolsFor(serverName: ServerName): ToolDefinition[]` — servers query this at startup
   - `findTool(name: string): ToolDefinition | undefined`
   - Idempotent registration (re-registering is a no-op with warning logged)
   - In-process singleton for Phase 1 (all servers run in same workspace); distributed registry is a Phase 2 concern

3. `ToolContext` — passed to tool implementations, contains:
   - tenantId (string | undefined — undefined only for mcp-admin-ops cross-tenant tools)
   - userId (string)
   - correlationId (string)
   - audit emitter
   - logger

4. `AuthProfile` — the declarative auth requirement per server:
   - mode: 'tenant-scoped' | 'device-scoped' | 'cross-tenant-with-audit-gate' | 'super-admin-only'
   - required_scopes?: string[]
   - requires_justification?: boolean (for audit-gated tools)

The registry has zero tools at P0.8. A trivial health tool may be registered per-server for protocol handshake testing, but no business logic.

## Part C: Three MCP server apps

Three apps under /apps/ — previously scaffolded as .gitkeep in P0.1, now populated:

/apps/mcp-cortex-core/
— Public MCP server, tenant-scoped
— Consumers: tenant users, their AI agents, Cortex internal agents, third-party integrations
— Auth: OAuth2 via AC01 (stub until AC01 lands in P2.1); reject unauth requests
— Trust model: ADR-MCP-002 (stub at P0.8, fleshed out before first tool lands)

/apps/mcp-edge/
— Edge zone MCP server, device-scoped with tenant attribution
— Consumers: edge devices, edge agents, third-party edge integrators
— Auth: device credentials (stub until S15 lands) + AC01 delegation for tenant attribution
— Trust model: ADR-MCP-003 (stub at P0.8)

/apps/mcp-admin-ops/
— Sevyn8-only MCP server, cross-tenant capable, privileged
— Consumers: Sevyn8 CSMs + engineers (via Claude Code or similar)
— Auth: WorkOS SSO + Super Admin role enforcement (stub until AC01 lands)
— Trust model: ADR-MCP-004 (stub at P0.8)
— CRITICAL: Network ingress restricted to Sevyn8 VPC; no public endpoint

Each server:

- Uses @modelcontextprotocol/sdk (current TypeScript MCP SDK, pinned version)
- Exposes HTTPS + SSE transport on a distinct port
- Pulls its tool catalog from @cortex/tool-registry at startup via `toolsFor('<server-name>')`
- Applies its server-specific auth middleware before invoking any tool
- Emits audit events for every tool invocation via @cortex/audit-events (per CLAUDE.md convention)
- Logs via @cortex/observability with correlation ID propagation
- Uses @cortex/tenant-context for per-request scoping (for cortex-core and edge)
- Has a /health endpoint that returns {status, tool_count, server, version, uptime_s}
- Has a Dockerfile for Cloud Run deployment (Cloud Run config lands in P0.3 Terraform)
- Is a thin adapter — no business logic in the server itself

Adapter implementation pattern (applies to all three servers):

1. Import registry, lookup tools for this server name
2. For each tool, register with the MCP SDK's server.tool() API using the tool's schemas
3. In the handler, apply server-specific auth middleware, extract ToolContext from the request, call tool.implementation(input, ctx), propagate the typed output, emit audit event
4. Expose /health endpoint outside the MCP transport

## Part D: Per-server trust-model ADR stubs

Three new ADRs under /docs/architecture/decisions/:

/docs/architecture/decisions/ADR-MCP-002-mcp-cortex-core-trust-model.md
/docs/architecture/decisions/ADR-MCP-003-mcp-edge-trust-model.md
/docs/architecture/decisions/ADR-MCP-004-mcp-admin-ops-trust-model.md

At P0.8, each ADR is a STUB containing:

- Status: Draft (to be finalized before first tool lands)
- Context: which server this governs, which consumers, what trust boundary applies
- Decision: placeholder — "trust model to be specified before first tool lands in this server"
- References: ADR-MCP-001, relevant spec sections

When the first tool is added to a server (typically in the first module prompt that registers one), the corresponding ADR is fleshed out with:

- Specific auth requirements
- Forbidden operations
- Audit requirements specific to that server
- Rate-limit profile
- Compliance integration points

Flesh-out is tracked as a blocker for the first-tool prompt, not for P0.8 itself.

## Dependencies on other P0 prompts

- P0.1 already scaffolded /apps/mcp-cortex-core, /apps/mcp-edge, /apps/mcp-admin-ops as .gitkeep stubs. P0.8 populates them. Remove the .gitkeep files per the repo convention.
- P0.6 @cortex/observability must exist — used by all three servers. If P0.6 hasn't run yet, re-order so P0.6 lands first.
- P0.7 @cortex/secrets must exist — used for MCP SDK config, OAuth client secrets. If P0.7 hasn't run, re-order.
- @cortex/audit-events lands in P0.10. If P0.10 hasn't run yet at P0.8 time, use a stub that logs to console + flags "audit events not yet wired" — replaced when P0.10 lands.
- @cortex/tenant-context already exists from P0.1 stubs.

## Acceptance

- All four capability-layer packages build (`pnpm --filter @cortex/cortex-tools-* build`)
- Tool registry package builds and its ToolDefinition type is exported cleanly
- All three MCP servers build and run locally (`pnpm --filter mcp-* dev`)
- `curl /health` returns 200 with correct shape on all three servers
- Each server, when connected via a generic MCP client (e.g., `npx @modelcontextprotocol/inspector`), lists its tool catalog (empty at P0.8, or containing only the test health tool)
- Three ADR stubs present at the specified paths
- .gitkeep files removed from /apps/mcp-\* directories (cleanup rule)
- Commit as `feat(mcp): protocol-agnostic tool platform + three server scaffolds per ADR-MCP-001`

## What's explicitly out of scope at P0.8

- Real tool implementations (modules add their tools in their own prompts)
- Real AC01 OAuth integration (AC01 lands in P2.1; use a signing-key stub until then)
- Cloud Run deployment (P0.3 Terraform; P0.8 only builds + runs locally)
- Distributed tool registry (Phase 2 concern; Phase 1 is in-process singleton)
- MCP SDK upgrades (pin the current version; bumps are housekeeping commits)

```

---

## P0.9: Super Admin bootstrap (NEW in v2)

**Spec reference:** AC01 §1.2 Authentication (pre-AC01 bootstrap)
**Dependencies:** P0.3 (infra), P0.7 (secrets)
**Output:** Bootstrap script + documented procedure

```

Create the Super Admin bootstrap procedure.

AC01 will not be built yet, but we need a documented, repeatable way to create the first Super Admin account in each environment (dev, staging, production) so that once AC01 is built in P2.1, we can immediately log in as Super Admin.

/scripts/bootstrap/
create-super-admin.ts
— Prompts for email, name, initial password (dev/staging only; production uses WorkOS SSO from day one)
— Writes to a bootstrap_admin table (migration created here)
— Once AC01 is built, this row is promoted to a real users row via migration
— Idempotent (safe to re-run)

Also:

- Document the production Super Admin process: WorkOS SSO with an initial user specified via environment variable, validated on AC01 first run
- Document emergency break-glass procedure at /docs/runbooks/super-admin-bootstrap.md

Acceptance:

- `pnpm bootstrap:super-admin --env=dev` creates a super admin
- Attempting to create a second super admin via the script is blocked with guidance
- Production bootstrap procedure documented
- Commit as `feat(bootstrap): super admin bootstrap procedure`

```

---

## P0.10: Audit event emission convention (NEW in v2)

**Spec reference:** §SCR-20-FR-009 (SHA-chain integrity); cross-cutting per all modules
**Dependencies:** P0.6 (observability baseline)
**Output:** Audit event library + convention doc + lint rule

```

Establish the audit event emission convention every module must follow.

Create /packages/audit-events:

- AuditEvent type: { event_id, tenant_id, actor_id, actor_type (USER/SYSTEM/AGENT), event_type, resource_type, resource_id, action (CREATE/READ/UPDATE/DELETE/APPROVE/REJECT/EXECUTE), before_state, after_state, reason, session_id, request_id, timestamp, ip_address, user_agent }
- emit() function — structured, signed (per SCR-20-FR-009 SHA-chain)
- Receives Pub/Sub topic audit.events
- Typed event catalogs per module (each module declares its event types)

Convention document at /docs/architecture/audit-event-convention.md specifying:

- Every mutating operation emits an audit event
- Every sensitive read (PII access, cross-tenant query, credential access) emits an audit event
- before_state and after_state required for UPDATE actions
- Denial events (authz rejected) also emitted
- Events are immutable post-emit

ESLint plugin at /packages/eslint-plugin-cortex/:

- Rule audit-on-mutation: warn if a function marked @Mutating() doesn't call emit()

Every subsequent module prompt references this convention. CLAUDE.md already declares compliance is required.

Acceptance:

- emit() works, writes to topic, structured log shows event
- Lint rule fires on violations
- Commit as `feat(audit): audit event emission convention`

```

---

# PART 1: FOUNDATION LAYER — F01 THROUGH F05

**Timing:** Week 2–4. These are load-bearing. Every subsequent module depends on F01 specifically.

---

## P1.1: F01 — Multi-Tenancy Infrastructure

**Spec reference:** §F01 in full
**Dependencies:** P0.4, P0.7
**Output:** Full F01 module — tenant context, database isolation, compute isolation, encryption, blob isolation, quotas

```

Implement F01 Multi-Tenancy Infrastructure in full per spec §F01 (starts around §1.1 Purpose).

Read the full F01 spec before writing code. This is the load-bearing module everything else depends on. Get it right.

Scope (per F01-FR-001 through F01-FR-006):

1. Tenant context propagation
   - Request middleware that extracts tenant_id from JWT or header, validates, injects into async-local context
   - Database session variable `app.current_tenant_id` set on every connection from pool
   - Middleware for HTTP (Fastify plugin), gRPC interceptor, Pub/Sub message wrapper
   - Every outbound call propagates tenant_id via headers / metadata

2. Database isolation (hybrid model)
   - Shared Postgres for Standard-tier tenants with Row-Level Security
   - Dedicated Cloud SQL instance for Enterprise-tier tenants
   - Abstraction layer: services never know which mode a tenant is in — the DB client picks the right instance based on tenant tier
   - Migration system applies to both modes transparently

3. Compute isolation
   - Kubernetes namespace per Enterprise tenant
   - Shared namespace with resource quotas for Standard tier
   - Pod labeling for tenant_id propagation

4. Encryption & key management
   - Per-tenant CMEK via /packages/secrets (already built in P0.7)
   - Transparent envelope encryption for PII-classified columns
   - Key rotation primitives (full rotation implemented in F02)

5. Blob storage isolation
   - Tenant-prefixed paths in GCS: gs://cortex-{env}-{tier}/tenants/{tenant_id}/...
   - IAM bindings via Workload Identity — service accounts can only access their own tenant prefixes
   - Pre-signed URL generator that embeds tenant scope

6. Resource quotas & noisy neighbor protection
   - Token bucket per tenant per resource class (DB connections, CPU seconds, RAM MB, API calls/min)
   - Return 429 when exceeded with Retry-After header
   - Metrics emitted for every throttle event

Implement all F01 FR-NNN requirements with corresponding tests. Produce the F01 acceptance criteria verification — write an integration test that demonstrates each acceptance criterion in the spec.

Data model: F01 §1.4 Control Plane Tables. Create tenant, tenant_config_version, tenant_quota_usage, tenant_kms_key tables in a CONTROL PLANE database (shared across all tenants, not RLS-protected — these tables ARE the tenant registry).

API surface: F01 §1.5. Expose via /packages/tenant-context.

Acceptance (each must pass):

- Two tenants' data is provably inaccessible across the boundary (RLS + CMEK)
- Tenant quota exceedance returns 429 within 50ms
- Integration test: provision 10 tenants, make 1000 concurrent requests across them, verify zero data leakage
- Tenant context propagates through HTTP → gRPC → Pub/Sub → HTTP chain
- Commit as `feat(F01): multi-tenancy infrastructure (foundation layer)`

```

---

## P1.2: F02 — Tenant Lifecycle Manager

**Spec reference:** §F02
**Dependencies:** P1.1
**Output:** Tenant provisioning / suspension / offboarding / export

```

Implement F02 Tenant Lifecycle Manager per §F02.

Scope (per F02-FR-NNN):

1. Tenant Provisioning Pipeline
   - Provisioning state machine: REQUESTED → PROVISIONING → READY → (optionally) SUSPENDED / OFFBOARDING / TERMINATED
   - Steps: allocate tenant_id, create KMS key, create GCS prefix, if Enterprise allocate dedicated Cloud SQL, run control-plane inserts, run tenant-scoped migrations, seed default config from IC01 vertical package, create initial admin invite, emit provisioning.completed event
   - Idempotent — re-running from any failure resumes
   - Transactional with rollback on any step failure
   - Asynchronous — driven by Cloud Tasks

2. Tenant Suspension
   - Set tenant status to SUSPENDED
   - Revoke active sessions via AC01
   - Block all data plane writes but allow reads for data export
   - Halt all scheduled jobs for the tenant
   - Emit suspended event for downstream cascades (S15 device pause, S17 outbound stop)

3. Tenant Offboarding & Data Export
   - On request: generate full data export archive (GCS signed URL, 30-day TTL)
   - After grace period (configurable, default 30 days): schedule termination
   - Termination: delete tenant-scoped data across all modules (tenant GCS prefix, tenant Cloud SQL instance if Enterprise, tenant rows in shared DB, tenant K8s namespace), then delete KMS key (tombstone for audit)
   - Legal hold: if any retention.legal_hold flag is set on tenant data, block termination with explicit Super Admin override workflow

F02 must integrate with:

- SCR-24 Platform Ops Dashboard (provisioning wizard UI)
- W01 Tenant Onboarding Wizard (provisioning trigger)
- SCR-20 Audit Log (every lifecycle event logged)

Key rotation is implemented here too (F02-FR-NNN key rotation): scheduled rotation of tenant CMEK with zero-downtime overlap. 90-day rotation default. Manual rotation on demand.

Data model per spec §2.3.

Acceptance:

- Provision a new Standard tenant end-to-end in under 5 minutes
- Provision an Enterprise tenant in under 30 minutes including dedicated Cloud SQL
- Rollback from a failed provisioning leaves no orphaned resources
- Termination after grace period deletes every trace; post-termination queries return tenant-not-found consistently
- Commit as `feat(F02): tenant lifecycle manager`

```

---

## P1.3: F03 — Temporal Data Engine

**Spec reference:** §F03
**Dependencies:** P1.1, P0.4 (bi-temporal helpers)
**Output:** Bi-temporal column enforcement, SCD policies, temporal query library, late-arriving handling

```

Implement F03 Temporal Data Engine per §F03.

Scope (per F03-FR-NNN):

1. Bi-Temporal Column Standard
   - Every tenant-scoped domain table MUST carry: valid_from, valid_to, txn_from, txn_to (tstzrange-backed)
   - Provide a TypeScript decorator / drizzle-kit plugin that generates migrations with these columns automatically
   - Linting rule: any PR adding a tenant-scoped table without bi-temporal columns fails CI
   - Migration helper: backfill_bitemporal(table_name) for rare legacy tables

2. SCD Policy Configuration
   - Per entity-type config in F04: SCD Type 1 (overwrite), Type 2 (new row per change), Type 3 (previous value in column), Type 4 (history table), Type 6 (hybrid)
   - Trigger-based automation — depending on configured type, update/insert behaves appropriately

3. Temporal Query Library
   - packages/temporal-query with functions: asOf(table, when), between(table, t1, t2), diff(table, t1, t2), currentState(table)
   - Exposed via tRPC API for admin screens and via SQL views for analytical screens

4. Late-Arriving Data
   - Configurable grace period per dataset (D04 quality context)
   - Events arriving within grace: corrected-backdate update
   - Events arriving beyond grace: late-arrival flag, manual review queue in SCR-08
   - Incremental re-materialization of affected Gold layer windows (S01 integration)

Acceptance:

- Create a retail.Product, update its price, query "as of last week" — returns last week's price
- An event arriving 2 hours late (grace = 1 hour) is flagged and appears in the review queue
- Gold layer KPIs re-materialize correctly when affected windows receive late data
- Commit as `feat(F03): temporal data engine with bi-temporal + SCD`

```

---

## P1.4: F04 — Configuration Plane

**Spec reference:** §F04
**Dependencies:** P1.1
**Output:** Tenant config store, draft/validate/promote/rollback, impact analysis, config-as-code sync

```

Implement F04 Configuration Plane per §F04.

This is the tenant-facing config layer. Every tenant-scoped setting lives here. Every configuration change goes through F04.

Scope (per F04-FR-NNN):

1. Configuration Store
   - Hierarchical key-value store per tenant in Postgres JSONB
   - Namespaces: platform._, tenant._, workspace.\*
   - Versioned — every change creates a new config_version row with parent pointer
   - Schema per namespace defined via Zod schemas, validated on write

2. Draft / Validate / Promote / Rollback lifecycle
   - draft(key, value) → config_draft row, visible only to author
   - validate(draftId) → runs all associated validators, returns pass/fail + warnings
   - promote(draftId) → moves to active; previous version retained for rollback
   - rollback(tenantId, key) → reverts to previous version, emits rolled-back event

3. Impact Analysis
   - Before promotion, compute downstream impact: which widgets/dashboards/pipelines consume this config
   - For breaking-impact changes, require explicit confirmation

4. Configuration-as-Code Sync (Enterprise only, deferred to Phase 2)
   - Stub the API; actual Git sync is Phase 2
   - Skeleton for bidirectional YAML export/import

Core configs managed via F04:

- Theme tokens (consumed by UX01)
- Locale and i18n (consumed by IC02)
- Feature flags
- Screen registry overrides
- Hierarchy schema (consumed by AC02)
- Retention policies (consumed by PR06)
- Quality rule library (consumed by D04)
- Vertical package selection (consumed by IC01)

Do NOT build the UI for F04 yet — that's SCR-04 Tenant Configuration & Theme, coming later. Just the engine + API.

Acceptance:

- draft → validate → promote → rollback round-trip works and produces correct audit trail entries
- Impact analysis identifies all downstream consumers before a breaking change
- Config reads are sub-10ms p99 (cached)
- Commit as `feat(F04): configuration plane`

```

---

## P1.5: F05 — Schema Evolution Engine

**Spec reference:** §F05
**Dependencies:** P1.3 (F03), P1.4 (F04)
**Output:** Schema change classification, versioning, feature store integration

```

Implement F05 Schema Evolution Engine per §F05.

Scope:

1. Change Classification
   - Classify every schema change as ADDITIVE (backward-compatible), BREAKING, or DEPRECATION
   - CI check: any migration must declare its classification; breaking changes require Super Admin approval in non-dev environments
   - Automated classifier: diff two schema versions and propose classification

2. Schema Versioning
   - Every D01 entity type is semver-versioned
   - Tenant pins to a major version by default; minor and patch auto-rollout
   - Version history queryable via API and surfaced in SCR-07

3. Feature Store Integration
   - When a feature's input schema changes, F05 notifies A01 to trigger feature re-computation or to invalidate stale features
   - Deferred — stub the hook; full A01 integration is Phase 2

Acceptance:

- Adding a new optional column is auto-classified ADDITIVE and deploys without approval in dev
- Renaming a required column is classified BREAKING and blocked in staging without approval
- Historical schema version is retrievable for any entity as of any date
- Commit as `feat(F05): schema evolution engine`

```

---

## P1.6: Feature Flags service (NEW in v2)

**Spec reference:** F04 consumer (cross-cutting feature management)
**Dependencies:** P1.4 (F04)
**Output:** Feature flag service + UX hooks

```

Build a feature flags service on top of F04.

/packages/feature-flags/

- Flag definition: { key, description, default_value, tenant_overrides, user_overrides, rollout_percentage }
- Evaluation: flag.isEnabled(tenantId, userId)
- Cache: sub-ms p99
- Server-side and client-side helpers (React hook for client)
- Admin UI stub for Phase 1 (full UI is part of SCR-04 Configuration later)

Conventions documented at /docs/architecture/feature-flags.md:

- Flag lifecycle: experimental → stable → retired (clean up code when retired)
- No flag older than 6 months stays without explicit renewal
- All flag evaluations logged for auditability via audit events

Initial flags to define:

- admin-console.display-data-workspace-switcher (gradual rollout)
- analytical.cx-dd-01-beta (start as beta for Display Data workspaces, promote when ready)
- agents.planogram.v2-model (model version rollout)
- ingestion.csv-agent-v2 (CSV agent version control)

Acceptance:

- Flag changes propagate to clients within 30s
- Admin UI stub exists
- Commit as `feat(feature-flags): feature flag service on F04`

```

---

# PART 2: ACCESS CONTROL — AC01 THROUGH AC04

**Timing:** Week 3–5. Can parallel with late Foundation work.

---

## P2.1: AC01 — ABAC + RBAC Engine

**Spec reference:** §AC01 in full
**Dependencies:** P1.1, P1.4
**Output:** Platform roles, tenant custom roles, attribute-based policies, authentication, authorization enforcement

```

Implement AC01 ABAC + RBAC Engine per §AC01.

This is the second-most load-bearing module after F01. Every read, every write, every action is gated through AC01.

Scope per AC01-FR-001 through AC01-FR-NNN:

1. Role Model
   - Platform roles (immutable, created at deployment): SUPER_ADMIN, TENANT_ADMIN, SUB_TENANT_ADMIN, DATA_STEWARD, ALGORITHM_MANAGER, END_USER
   - Tenant-custom roles derived from platform roles with overrides
   - Role assignment: user ↔ role, scoped by hierarchy (AC02) and workspace (F01/F02)

2. Attribute-Based Policies (ABAC)
   - Policy language: declarative Rego-like syntax (use OPA or Cedar — evaluate both in an ADR)
   - Policies: resource.attr × user.attr × env.attr → allow / deny / deny-with-mask
   - Column-level PII masking: policies can return a masking directive

3. Authentication
   - OAuth2 + OIDC (self-hosted via Auth0 or WorkOS for Enterprise tenants)
   - JWT issuance with tenant_id, user_id, roles, scopes claims
   - Session management, refresh token rotation
   - MFA enforcement (TOTP + WebAuthn)
   - API keys (handled in SCR-18 Developer Portal later; here: key validation)

4. Authorization Enforcement Points
   - Middleware for HTTP, gRPC, GraphQL, Pub/Sub message handlers
   - Decorator for service methods: @Requires('role:DATA_STEWARD')
   - Policy decision point: ultra-fast (<5ms p99); cached per session
   - Policy information point: reads from AC02 hierarchy, F04 config, tenant context

5. Data Model per AC01 §1.3: platform_role, tenant_role, role_permission, user_role_assignment, abac_policy, policy_version

Performance targets:

- Authorization decision p99 < 5ms for cached policies
- Policy change propagation to active sessions < 30 seconds

Integration hooks for later:

- SCR-06 Role & Permission Manager will consume AC01's policy authoring API
- SCR-02 Users will consume AC01's role-assignment API
- SCR-20 Audit Log records every authz decision for sensitive resources

Acceptance per AC01 §1.4:

- Tenant Admin can create a custom role "Regional Analyst" with hierarchy scope, PII masking, aggregation-only below city level in under 5 minutes
- Authorization decision benchmarks pass
- Policy simulator (skeleton) returns correct allow/deny with trace
- Commit as `feat(AC01): abac + rbac engine`

```

---

## P2.2: AC02 — Hierarchy Engine

**Spec reference:** §AC02
**Dependencies:** P1.1, P1.4
**Output:** Hierarchy CRUD, versioning, multi-hierarchy, cross-hierarchy mapping

```

Implement AC02 Hierarchy Engine per §AC02.

Scope:

1. Hierarchy data model supporting arbitrary depth DAG (not just tree — cross-hierarchy mappings require DAG)
2. Node types configurable per vertical (retail default: Chain → Region → City → Store → Zone)
3. Bi-temporal versioning via F03 — hierarchy at any past date is queryable
4. Scheduled reorganizations — draft reorg, effective date, validate, commit
5. Multi-hierarchy support — operations, reporting, logistics as separate hierarchies
6. Rollup queries: given a node, compute sum of child metrics; respect bi-temporal context

Operations:

- add(parent, node)
- move(node, newParent, effectiveDate)
- archive(node, effectiveDate)
- merge(nodeA, nodeB, effectiveDate)
- diff(versionA, versionB)
- rollup(rootNode, metric, asOf)

Integration:

- AC01 uses hierarchy for role scoping
- CX-01 and CX-02 use rollups
- SCR-05 Hierarchy Manager is the UI

Acceptance:

- A reorg of 30 stores drafts-validates-commits in under 1 minute
- As-of queries against historical hierarchy return correct structure
- Rollup query across 500 stores completes in <200ms
- Commit as `feat(AC02): hierarchy engine`

```

---

## P2.3: AC03 — Consent & Privacy Manager

**Spec reference:** §AC03
**Dependencies:** P1.1, P1.4
**Output:** Consent state machine, purpose registry integration, withdrawal cascade

```

Implement AC03 Consent & Privacy Manager per §AC03.

Scope:

1. Consent state machine per entity × purpose: NOT_CAPTURED → GRANTED → WITHDRAWN → EXPIRED → RE_GRANTED
2. Per-purpose consent storage: entity_id, tenant_id, purpose_id (from PR01), state, granted_at, withdrawn_at, source (which touchpoint captured it), template_version
3. Withdrawal cascade state machine:
   - 15 minutes: all real-time processing filters this entity for this purpose (S01, A03, O04)
   - 1 hour: edge consent propagation (ED01 acknowledgement required)
   - 24 hours: analytics layer re-materialization to drop this entity from gold-layer aggregates for this purpose
   - 7 days: full erasure from any non-retained store
4. Per-tenant configurable cascade SLAs, never looser than above
5. Body Shop-style two-touchpoint consent bundling: purpose bundles with required vs optional membership

Integration: PR01 (purposes), S01 (streaming filter), ED01 (edge cascade), A03 (decision filter), O04 (outbound gate), SCR-16 (admin UI), CX-03 (per-entity consent view)

Acceptance:

- Consent withdrawal cascade hits all four SLAs with measurable telemetry
- Acknowledgement-pending state visible in SCR-16
- Cascade failure raises CRITICAL alert to SCR-22
- Commit as `feat(AC03): consent & privacy manager`

```

---

## P2.4: AC04 — Compliance-as-Code Policy Engine

**Spec reference:** §AC04
**Dependencies:** P2.1 (AC01 policy engine reuse)
**Output:** Declarative compliance rules, policy library, compliance score

```

Implement AC04 Compliance-as-Code Policy Engine per §AC04.

Scope:

1. Declarative policy authoring reusing AC01's policy engine — but for regulatory rules (DPDP, GDPR, PCI-DSS, HIPAA, Solvency II, FINMA, IRDAI)
2. Policy bundles per vertical: retail includes DPDP + PCI-DSS; reinsurance adds Solvency II + FINMA
3. Enforcement modes per rule: BLOCK / AUDIT / INFO
4. Compliance score computation: aggregate pass rate across all active policies
5. Feature Exclusion policies: blocked features auto-disabled in A01 Feature Store (e.g., gender excluded from pricing algorithms)
6. Cross-border transfer policies: block queries that would exfiltrate data across residency boundaries

Integration: SCR-22 Compliance Operations (UI), S20 (audit), AC01 (policy engine), every data-plane module reads compliance decisions

Acceptance per AC04 §4.3:

- Feature Exclusion policy correctly blocks a feature store query
- Cross-border policy blocks a query with clear error
- Policy inheritance: insurance vertical tenant auto-inherits IRDAI rules
- Commit as `feat(AC04): compliance-as-code policy engine`

```

---

# PART 3: DATA PLATFORM — D01 THROUGH D06

**Timing:** Week 4–6. D01 is the language everything else speaks.

---

## P3.1: D01 — Canonical Data Model (retail ontology)

**Spec reference:** §D01 in full
**Dependencies:** P1.3 (F03), P1.4 (F04)
**Output:** Core ontology + retail extension ontology + Gold-layer KPI definitions

```

Implement D01 Canonical Data Model per §D01. This is the universal language — every other module speaks it.

Scope:

1. Three-tier ontology:
   - Tier 1 Core: Entity, Event, Asset, Location, Relationship, Observation, Programme
   - Tier 2 Retail Extension: retail.Customer, retail.Store, retail.Product, retail.Transaction, retail.TransactionLineItem, retail.LoyaltyAccount, retail.StockLevel, retail.OnlineSession, retail.Shelf, retail.Planogram, retail.Promotion
   - Tier 3 Tenant Extension (stub — actual tenant extensions go through F05 + SCR-07)

2. For each entity type per spec §1.3–§1.4:
   - TypeScript type in /packages/canonical-schema/src/entities/
   - Zod schema for runtime validation
   - Postgres table migration (tenant-scoped, bi-temporal, RLS-enabled)
   - Drizzle ORM schema
   - PII classifications per attribute
   - Relationship definitions

3. Graph model per §1.5: Entity-relationship graph queryable via a graph-layer API

4. Gold-Layer KPI definitions per §1.6:
   - Store Performance Funnel: footfall → conversion → basket size → basket value → revenue
   - Customer Lifecycle Funnel: acquisition → activation → retention → loyalty → CLV
   - Each KPI: formula, grain, dimensions, freshness SLO, owner

5. Canonical namespace: retail.\* prefix for all retail entities

Migration approach: one migration file per entity type, chained via F05 version control.

Acceptance per D01 §1.7:

- Every entity has a one-sentence semantic description (no 'TBD' anywhere)
- Graph queries: given a Transaction, traverse to Customer, to LoyaltyAccount, to past Transactions — <100ms
- KPI formulas compile against the schema and produce numbers for the demo tenant
- Commit as `feat(D01): canonical data model + retail ontology`

```

---

## P3.2: D02 — Canonical Mapping Engine

**Spec reference:** §D02
**Dependencies:** P3.1
**Output:** Mapping rule engine + auto-mapping + execution pipeline

```

Implement D02 Canonical Mapping Engine per §D02.

Scope:

1. Mapping rule model: source_schema × canonical_entity × transformation_expression → canonical rows
2. Transformation language: restricted sandboxed subset (no I/O, deterministic). Common utilities: date parsing, string normalization, phone E.164, GTIN validation, currency conversion via IC02, lookup tables, hash
3. Auto-mapping engine: given a source schema (from CSV headers, JDBC metadata, JSON sample), propose mappings with confidence scores. Use:
   - Name similarity (Levenshtein, token-set ratio)
   - Type compatibility
   - Value distribution matching (if sample data available)
   - LLM-assisted semantic matching via A05 (stub until A05 exists — accept manual flag)
4. Mapping execution pipeline: read source → apply rules → validate against Zod schema → emit to canonical topic
5. Versioned as D03 contracts

Acceptance:

- Auto-map a 30-column retail POS export with >90% field-level accuracy
- Map execution processes 10K records/second
- Rule commit triggers retroactive validation against last 1K records, blocks commit if failure >1%
- Commit as `feat(D02): canonical mapping engine`

```

---

## P3.3: D03 — Data Contracts Framework

**Spec reference:** §D03
**Dependencies:** P3.2
**Output:** Contract versioning, breaking change detection, deployment

```

Implement D03 Data Contracts Framework per §D03.

Scope:

1. A contract = a frozen combination of source_schema + mapping_rules + quality_rules + SLAs
2. Versioned with semver; breaking changes require explicit approval
3. Contract deployment triggers: mapping execution uses the active version; old records stay on their historical version
4. Contract testing harness: run a contract against a sample batch, output pass/fail report with diffs

Acceptance:

- Two versions of a contract can coexist during transition; readers specify version
- Breaking contract change blocked at commit with diff shown
- Commit as `feat(D03): data contracts framework`

```

---

## P3.4: D04 — Data Quality Engine

**Spec reference:** §D04
**Dependencies:** P3.1, P3.2
**Output:** Rule library, incident stream, quality scoring, promotion gates

```

Implement D04 Data Quality Engine per §D04.

Scope per D04 key FRs:

1. Rule types: not-null, unique, range, regex, referential-integrity, custom-SQL, statistical-anomaly
2. Severity: INFO / WARN / ERROR / BLOCK — controls medallion promotion behaviour
3. Rule execution: on every record on ingest (streaming) + scheduled batch checks
4. Quality scoring: 6 dimensions (freshness, completeness, uniqueness, validity, consistency, timeliness) → per-dataset score → tenant rollup
5. Incident deduplication, acknowledgement, resolution tracking
6. Promotion gates Bronze → Silver → Gold controlled by configurable thresholds per dataset

Acceptance:

- Every dataset has a quality score in near-real-time
- Held records enumerable and explainable
- Force-promotion requires justification and audit log
- Commit as `feat(D04): data quality engine`

```

---

## P3.5: D05 — Data Lineage & Provenance

**Spec reference:** §D05
**Dependencies:** P3.1, P3.2, P3.4
**Output:** Per-record lineage, DAG visualization API, impact analysis

```

Implement D05 Data Lineage & Provenance per §D05.

Scope:

1. Lineage capture: every transformation records input record IDs, transformation type, output record IDs, timestamp. OpenLineage compatible.
2. Lineage graph stored in a graph-suitable store (PostgreSQL with recursive CTEs acceptable for Phase 1; defer graph DB to Phase 3)
3. Lineage query API: upstream(recordId), downstream(recordId), impact(field, table)
4. Surfaces in SCR-20 Audit Log and SCR-08 Data Source Wizard

Acceptance:

- Traversal from Gold KPI to originating source record completes in <3s at 50-node DAG depth
- Impact analysis before schema change enumerates every downstream consumer
- Commit as `feat(D05): data lineage & provenance`

```

---

## P3.6: D06 — Polyglot Storage Layer

**Spec reference:** §D06
**Dependencies:** P3.1
**Output:** Storage abstraction, engine mapping, query planner

```

Implement D06 Polyglot Storage Layer per §D06.

Scope:

1. Storage engine mapping per data class:
   - Operational records → Postgres (Cloud SQL)
   - Analytical aggregates → BigQuery
   - Blob / media → GCS
   - Real-time features → Redis / Memorystore
   - Search / embeddings → pgvector + Vertex AI Vector Search (when we add it)
   - Time-series telemetry → Cloud Monitoring + BigQuery (for long retention)
2. Storage abstraction: services call storage.get(entity, id) — the layer picks the right engine
3. Query planner: route queries to the engine most suited; cross-engine joins via pipeline

Acceptance:

- A single service can read a retail.Customer from Postgres and their historical transactions from BigQuery via one API call
- Query latency routing is observable
- Commit as `feat(D06): polyglot storage layer`

```

---

# PART 4: IDENTITY & INGESTION — I01 through I03, G01, G02

**Timing:** Week 5–7.

---

## P4.1: I01 — Probabilistic Identity Registry (SIR)

**Spec reference:** §I01 in full
**Dependencies:** P3.1, P3.6
**Output:** Identity signal framework, match scoring, merge/split, performance

```

Implement I01 Probabilistic Identity Registry per §I01.

Scope per I01-FR-NNN:

1. Identity signal framework: every source contributes signals (email, phone, loyalty ID, face embedding from ArcFace, device fingerprint) with per-signal weights
2. Match scoring algorithm: weighted probabilistic score [0,1]; auto-merge above threshold (default 0.95); quarantine below (default 0.7 < x < 0.95); non-match below (<0.7). Configurable per tenant via F04.
3. Identity graph: node = resolved entity (UEID); edges = signals linking entities
4. Merge / split operations with lineage preservation
5. Resolution performance: <50ms p95 for real-time inference; <5s for batch resolution of 10K new signals
6. Cross-channel resolution: the same customer across POS, CRM, e-commerce, edge recognition, loyalty

Acceptance per I01 §1.3:

- Steward merges two quarantined entities in <30s
- 10K signal batch resolves in <5s
- Merge preserves lineage — historical decisions still attribute correctly
- Commit as `feat(I01): probabilistic identity registry`

```

---

## P4.2: I02 — Knowledge Graph

**Spec reference:** §I02
**Dependencies:** P3.1, P4.1
**Output:** Graph store, traversal API, query surface

```

Implement I02 Knowledge Graph per §I02. Minimal Phase 1 scope — full graph DB is Phase 3.

Scope:

1. Graph storage: PostgreSQL with recursive CTEs + materialized views for common traversals; interfaces isolated so we can swap to a graph DB later
2. Query API: traverse(startNode, relationshipTypes, maxDepth)
3. Correlated Event Groups storage (from S02 later)

Acceptance:

- Traversal from customer to their last 10 transactions to their 5 most-bought product categories returns in <200ms
- Commit as `feat(I02): knowledge graph (phase 1 scope)`

```

---

## P4.3: I03 — Multi-Source Conflict Resolution (DEFERRED to Phase 2 in v2)

**Status in v2:** **SKIP THIS PROMPT.** I03 is deferred to Phase 2 per architectural decision. For Display Data Phase 1 (mostly store/product/transaction, minimal customer identity resolution), I03 is not on the critical path. Body Shop drives demand for I03 in Phase 2.

**If you still want a minimal conflict resolution primitive in Phase 1:** Implement most-recent-wins as a single function in I01's resolution path. Full I03 with configurable per-attribute strategies and conflict dashboard comes in Phase 2.

### Original prompt (preserved for Phase 2 execution)

**Spec reference:** §I03
**Dependencies:** P4.1
**Output:** Conflict detection + resolution strategies + conflict dashboard

```

Implement I03 Multi-Source Conflict Resolution per §I03.

Scope:

1. Detect attribute-level conflicts across sources (customer.phone from POS says X, from CRM says Y)
2. Resolution strategies per attribute: most-recent, highest-trust-source, source-priority, manual
3. Conflict dashboard feeds SCR-11 Entity Resolution Console
4. Exception rules: for edge cases, steward can pin a resolution

Acceptance:

- Conflicting attributes surface within 1 minute of ingestion
- Resolution strategy per attribute is configurable without code change
- Commit as `feat(I03): multi-source conflict resolution`

```

---

## P4.4: G01 — Universal Ingestion Gateway (UPDATED in v3)

**Spec reference:** §G01 in full
**Dependencies:** P3.2 (D02), P3.4 (D04), P2.3 (AC03 for consent gating), P0.7 (secrets for Kafka credentials), P1.x (@cortex/event-bus package built)
**Output:** Multi-protocol ingestion gateway with first-class Kafka support + ROOS connector as flagship
**Governing ADRs:** ADR-INFRA-001 (event bus), ADR-SCOPE-009 (ROOS external)

```

Implement G01 Universal Ingestion Gateway per /docs/spec/cortex_v2.docx §G01.

Before coding:

- Read /docs/architecture/decisions/ADR-INFRA-001-event-bus-choice.md — governs event bus architecture (Pub/Sub internal, Kafka at edges)
- Read /docs/architecture/decisions/ADR-SCOPE-009-roos-external.md — governs the ROOS boundary
- Read /docs/integrations/roos-interface.md — the contract with Ithina (may be stubbed; read what exists)

G01 is the single entry point for all external data flowing into Cortex. Internal Cortex services NEVER reach out to external systems for data; they always consume from Pub/Sub topics that G01 publishes to. This is a hard architectural boundary.

## Scope per G01-FR-001 through G01-FR-NNN

1. Connector abstraction framework (/services/ingestion/g01/connectors/)
   Every connector implements the same interface: configure, test-connection, start, pause, stop, drain. Registered by protocol type. Per-tenant configurations stored in F04.

2. Ingestion modes supported at launch:
   - Kafka consumer (first-class — see below)
   - HTTPS webhook receiver
   - SFTP poll
   - GCS/S3 watch
   - JDBC (Postgres, MySQL, BigQuery, Snowflake)
   - REST API poll
   - Manual CSV/Excel upload (admin UI)
   - Google Sheets

3. Canonical envelope (G01-FR-NNN envelope):
   Every ingested record, regardless of source, wrapped with:
   { ingestion_id, tenant_id, source_id, source_type, source_checksum, ingested_at, received_at, raw_payload_ref (GCS path), validation_state, schema_version, correlation_id }

4. Deduplication: content-hash-based, per-source configurable window (default 24h).

5. Routing: tag with target pipeline (G02 structured, G03 documents, G04 video, G05 audio, G06 IoT). Phase 1 only G02 active; tags are set even when downstream pipelines don't exist yet so future routing works without re-ingestion.

6. Emit to internal Pub/Sub topic `ingest.raw` via @cortex/event-bus — NEVER direct to kafkajs or @google-cloud/pubsub (enforced by lint rule).

7. DLQ: emit to `ingest.dlq` Pub/Sub topic with structured reason_code (INVALID_SCHEMA, AUTH_FAILED, DUPLICATE, QUARANTINED, UPSTREAM_ERROR, etc.). Surfaces in SCR-08.

## Kafka as a first-class connector — specific requirements

Per ADR-INFRA-001, Kafka is the primary external streaming protocol. Implement it to a higher bar than "one of many connectors":

1. Use kafkajs (most mature Node.js Kafka client, 2026 ecosystem standard).

2. Connection config per G01 Kafka connector:
   - Broker list (comma-separated), client_id, ssl/sasl toggle
   - SASL mechanism (PLAIN, SCRAM-SHA-256, SCRAM-SHA-512)
   - Username/password retrieved from @cortex/secrets (never env vars in staging/prod)
   - Consumer group id (per tenant per source, e.g., cortex-{env}-{tenantId}-{sourceId})
   - Topics to subscribe (list, supports wildcards)
   - Auto-offset-reset policy (earliest for backfill, latest for go-forward)
   - Max poll records, session timeout, heartbeat interval — all tunable per source

3. Schema handling:
   - Support Avro (via Confluent Schema Registry client) AND Protobuf AND raw JSON
   - Per-source schema expectation declared at connector configuration time
   - Validate every message against Zod schema derived from expected schema
   - On validation failure: route to DLQ with reason_code=INVALID_SCHEMA + diff
   - Schema evolution detection: if incoming schema differs from registered, flag for D03 contract review

4. Backpressure:
   - Consumer pauses if downstream Pub/Sub publish rate drops (avoids cascading buffer overflow)
   - Consumer lag metric emitted every 30s: kafka_consumer_lag{tenant,source,topic}
   - Alert rule: if lag > 1 minute sustained > 5 minutes, fire to O02

5. Failure handling:
   - Broker unreachable → exponential backoff with jitter, max 30 min retry, then alert
   - Auth failure → immediate alert, no retry (needs human fix)
   - Message parse failure → DLQ, continue consuming

6. Observability:
   - OpenTelemetry spans per message (partition, offset, consumer group)
   - Structured logs for every auth success, failure, partition assignment change, rebalance
   - Per-tenant metrics: messages consumed, DLQ rate, bridge throughput, consumer lag

7. Multi-tenancy:
   - A single Kafka connector may serve multiple tenants if the upstream topic multiplexes (ROOS pattern — see next section)
   - Per-message tenant extraction from message headers OR message body field (configurable)
   - Strict fail-closed: if tenant cannot be determined, DLQ with reason_code=TENANT_MISSING

## ROOS connector — flagship implementation (Display Data Phase 1 critical path)

ROOS is Ithina's external multi-tenant ingestion platform. Cortex does NOT subsume ROOS; Cortex consumes from ROOS as an upstream source per ADR-SCOPE-009.

Build the ROOS connector as a specialized configuration of the generic Kafka connector:

1. Location: /services/ingestion/g01/connectors/kafka/sources/roos/

2. Subscribes to dis.golden.roos — the canonical output topic Ithina publishes to. Do NOT subscribe to dis.ingest.\* — those are Ithina's internal topics and are not part of the integration contract.

3. Authentication: Ithina provides broker endpoint, SASL mechanism, credentials. Stored in Secret Manager path `roos/display-data/kafka-creds`. Rotated quarterly per agreement with Ithina ops.

4. Schema: ROOS canonical event format (Avro; schema pulled from Ithina's Schema Registry OR static schema file shipped with the connector — TBD in /docs/integrations/roos-interface.md).

5. Tenant extraction: ROOS multiplexes multiple Ithina downstream clients on the same topic. The tenant identifier lives in message header `ithina_tenant_id` which maps to Cortex workspace id (per the multi-workspace Display Data configuration). Connector filters or splits by this field; events for unrecognized tenants route to DLQ with reason=UNRECOGNIZED_TENANT.

6. Schema translation: ROOS canonical ≠ Cortex canonical. D02 mapping rules translate ROOS events to Cortex retail.\* entities. Initial mapping provided as a starter D03 data contract; refined over first 30 days of integration.

7. Error handling:
   - If ROOS topic unreachable > 15 min: CRITICAL alert, paged to Sevyn8 on-call + escalate to Ithina ops (runbook: /docs/runbooks/roos-outage.md)
   - Messages with schema unrecognized by Cortex: DLQ + surface to SCR-08 with reason "upstream ROOS schema change, coordinate with Ithina"
   - Bridge throughput lag > SLA: soft alert to Display Data CSM

8. Integration testing:
   - A staging ROOS instance OR a mock ROOS producer is required for development. If not available, a fixtures-based simulator at /services/ingestion/g01/connectors/kafka/sources/roos/fixtures/ produces realistic ROOS canonical events for local dev.
   - E2E test: inject a ROOS event → verify it lands on ingest.raw → verify it flows through G02 → verify it becomes a retail.Transaction in Silver layer.

9. Do NOT implement anything ROOS does internally. Do not build POS listeners (Square/Clover/Lightspeed). Do not build fat/skinny enrichment. Do not subscribe to Ithina's internal topics. The boundary is strict: Cortex consumes dis.golden.roos, full stop.

## Other Phase 1 connectors (secondary priority after Kafka/ROOS)

- HTTPS webhook: signed HMAC verification, 500ms ACK SLO, idempotency via event_id header, routes to ingest.raw. Shelf imagery from HHT app uses this path (not Kafka).
- Manual CSV upload: triggered from SCR-08 UI, file lands in tenant GCS prefix, G01 parses, proposals route to SCR-09 via the CSV Ingestion Agent (P10.7).
- SFTP poll: scheduled watcher, lands files in Bronze, parses per connector schema.
- JDBC (Postgres/MySQL/BigQuery/Snowflake): scheduled queries, CDC where possible, polling where not.
- GCS/S3 watch: Eventarc-triggered for GCS; polling for S3.
- REST API poll: scheduled, supports OAuth2 / API key / basic auth.
- Google Sheets: Google API integration with service account.

Each connector has its own directory under /services/ingestion/g01/connectors/ with a README, config schema, test fixtures, and a smoke test.

## The @cortex/event-bus integration (critical)

Per ADR-INFRA-001:

- G01 is the ONLY part of Cortex that touches external protocols (Kafka, webhook, etc.)
- Once validated and enveloped, events go onto internal Pub/Sub via @cortex/event-bus
- Every other Cortex service subscribes via @cortex/event-bus, not directly to Pub/Sub
- Lint rule: imports of @google-cloud/pubsub or kafkajs outside G01 fail CI

This is the seam that makes Cortex portable in the future. Honor it strictly.

## Data model per G01 §4.3

Control-plane tables:

- source_config (tenant-scoped, F01 RLS): source_id, tenant_id, source_type, name, connector_config JSONB, schema_registry_ref, dedup_window_hours, is_active, created_at, updated_at
- source_health: source_id, last_successful_poll, last_failure_at, consecutive_failures, lag_seconds, state enum
- source_auth_secret: source_id, secret_ref (points to Secret Manager path)

All schemas and migrations use Drizzle per stack decisions in CLAUDE.md.

## Acceptance per G01 §4.3

- Kafka consumer against ROOS staging instance reads real events, validates schema, emits to ingest.raw within 200ms p95 end-to-end
- ROOS connector outage simulated (disconnect broker) → alert fires within 15 min, consumer resumes cleanly on reconnection without losing messages
- 50K-row CSV ingests in <2 minutes; every row arrives in ingest.raw
- Deduplication catches exact duplicates with 100% precision
- DLQ entries are queryable via SCR-08 with full reason codes and diffs
- Consumer lag visible in Cloud Monitoring; alert rule triggers appropriately
- E2E test: ROOS event → G02 → Silver layer retail.Transaction in <5 seconds p95

Integrate with:

- F01 tenant context (every event has tenant_id)
- AC03 consent check — for events involving PII, verify consent before emit to ingest.raw; if consent missing, route to quarantine
- @cortex/observability for logging/metrics/tracing
- @cortex/audit-events — emit audit event per source configuration change and per connector lifecycle event (start/stop/pause)
- @cortex/http-errors for error responses from admin APIs
- Update /docs/progress/status.md

Commit as `feat(G01): universal ingestion gateway with kafka+ROOS`

Prompt: P4.4
Spec: §G01
ADRs: ADR-INFRA-001, ADR-SCOPE-009

```

**Fallback if Claude Code hits context window limits during P4.4:**

If the prompt is too large for a single session, split into:
- P4.4a: Generic G01 connector framework + envelope + routing + DLQ
- P4.4b: Kafka connector (generic, not ROOS-specific)
- P4.4c: ROOS connector specialization
- P4.4d: Webhook + CSV + SFTP connectors

Execute in order. Each session starts with M1 + a re-read of commits from the previous session.

---

## P4.5: G02 — Structured Data Pipeline

**Spec reference:** §G02 in full
**Dependencies:** P4.4, P3.2, P3.4
**Output:** Pipeline stages + DLQ management + line-item handling

```

Implement G02 Structured Data Pipeline per §G02.

Scope:

1. Pipeline stages: Envelope-validated → D02-mapped → D04-quality-checked → Silver-layer-written → canonical topic emitted
2. Dead-letter queue per stage with reason codes
3. Line-item handling for complex entities (retail.Transaction with TransactionLineItem children) — atomic write
4. Surfaces DLQ entries in SCR-08

Acceptance per G02 §5.3:

- 10K records / second sustained throughput
- DLQ re-ingestion (after fix) succeeds for 100% of previously-rejected records that now pass
- Commit as `feat(G02): structured data pipeline`

```

---

# PART 5: CROSS-CUTTING PLATFORM

**Timing:** Week 6–8. These enable later work but aren't UI-visible until their screens are built.

---

## Template for P5.x cross-cutting prompts

For each cross-cutting module in P5.1 through P5.15, use this template as the base prompt:

```

For [MODULE ID] ([MODULE NAME]):

1. Read /docs/spec/cortex_v2.docx section for this module in full
2. Identify dependencies and verify they're already implemented (check /docs/progress/status.md)
3. Implement all FR-NNN requirements
4. Write tests for each acceptance criterion
5. Integrate with F01 tenant context, AC01 authorization, @cortex/observability logger, @cortex/audit-events (per P0.10 convention)
6. Use @cortex/http-errors for error responses (per P5.19 standard format)
7. Expose API surface via tRPC (internal) and O01 (external)
8. Update /docs/progress/status.md
9. Commit as `feat([MODULE_ID]): [short description]`

```

Execute this template for each module below. Module-specific notes are noted where relevant.

---

## P5.1: S01 Stream Processing Engine

Use the template above. Module-specific notes:
- Dataflow jobs for Bronze→Silver→Gold pipeline
- Exactly-once semantics for financial data (transactions, payments)
- Late-arriving event handling integrates with F03 grace period config
- Windowing configurable per pipeline (tumbling, sliding, session)

## P5.2: IC01 Industry Ontology Framework (engine only)

Use the template. Module-specific notes:
- Vertical package loader — reads package YAML + validates against schema
- Package registry table per tenant (which packages are active)
- Package version lifecycle: staged → active → retired
- **Note:** The *retail package content* is a separate prompt (P5.17), as is the Display Data extension (P5.18)

## P5.3: IC02 Localization & i18n Engine

Use the template. Module-specific notes:
- Locale store: en-IN (default), en-US, framework-ready for hi-IN / ta-IN
- Currency conversion with configurable rates (not real-time FX for Phase 1)
- Number formatting: Indian lakh/crore (12,34,567) vs Western (1,234,567)
- Date formats, first-day-of-week per locale
- i18n library: `next-intl` (Phase 1 default)
- String extraction workflow documented for translators

## P5.4: A05 LLM Gateway

Use the template. Module-specific notes:
- Anthropic API wrapper via official SDK
- Prompt templates stored in F04, versioned
- Token accounting emitted as metrics (per-tenant cost tracking)
- Structured output enforcement (function calling / tool use)
- Response streaming (SSE) support
- Fallback provider stub for Phase 1 (real fallback Phase 2+)
- Per-tenant rate limits

## P5.5: A06 Rule Engine

Use the template. Module-specific notes:
- Declarative rules + decision tables (JSON-logic or similar)
- No I/O in rules (deterministic evaluation)
- Versioned rule bundles tenant-scoped via F04
- Audit events on rule evaluation for traceability

## P5.6: O01 API Gateway & Integration Layer

Use the template. Module-specific notes:
- OpenAPI surface generated from tRPC router where possible
- Rate limiting: token bucket per API key per endpoint
- API key auth for programmatic clients; JWT for browser clients (both via AC01)
- Request tracing through OpenTelemetry (P0.6 observability)
- **Uses standard error format from P5.19**
- API versioning via URL path: /v1/, /v2/
- Deprecation headers surfaced when v1 endpoints marked deprecated

## P5.7: O02 Notification & Alert Engine

**Note:** Spec classifies O02 as Phase 2, but SCR-19 (Phase 1) requires it. v2 moves O02 into Phase 1.

Use the template. Module-specific notes:
- Alert rule evaluation on streaming events (via S01)
- Routing: user / team / channel / webhook / in-app
- Escalation chains with configurable SLA
- Digest modes: immediate, hourly, daily
- Quiet hours per recipient
- Integrates with O04 for delivery

## P5.8: O04 Integration & Action Hub (Phase 1 core)

Use the template. Module-specific notes:
- Action dispatcher receiving ActionRequest events from A03/O02
- Consent gate (AC03) BEFORE every outbound action — no override
- Channel registry: tenant-configurable enabled channels
- Phase 1 connectors: Webhook, Email (Resend), CRM (Salesforce/HubSpot)
- Phase 2 connectors (deferred): WhatsApp Business, SMS, Dialer, Marketing Automation push
- Template engine consuming F04 templates
- Priority queue with dead-letter topic
- 7-year audit log of every action dispatched

## P5.9: OB01 Platform Observability Stack

Use the template. Module-specific notes:
- Cloud Operations integration (Logging, Monitoring, Trace, Error Reporting)
- SLO definitions per service; error budgets tracked
- Structured error aggregation with de-duplication
- Dashboards pre-built for each module's key metrics
- Exported as OpenTelemetry-compatible so future tools can plug in

## P5.10: OB02 FinOps & Cost Management (stub for Phase 1)

Phase 1 stub scope:
- Per-tenant cost attribution framework (schema only, populated later)
- API endpoint that returns "coming soon" for now
- Phase 2 builds out optimization suggestions, budget alerts, forecasting

## P5.11: OB03 Metering & Billing (stub for Phase 1)

Phase 1 stub scope:
- Per-resource metering counters (events ingested, API calls, storage GB, compute seconds, agent invocations)
- Aggregation to daily tenant bills (persisted but not invoiced in Phase 1)
- Phase 2 builds invoice generation, payment integration, revenue recognition

## P5.12: PR01 Processing Purpose Registry

Use the template. Module-specific notes:
- Purpose CRUD with lifecycle: DRAFT → ACTIVE → DEPRECATED → RETIRED
- DPIA (PR04, Phase 2) gating for high-risk purposes
- Per-purpose: data categories, retention, legal basis, cross-border flag
- Integrates with AC03 Consent Manager
- Display Data defaults: Service Delivery, Analytics (derived only), placeholder for future customer data purposes

## P5.13: PR03 Breach Detection & Response

Use the template. Module-specific notes:
- Anomaly detection on data access patterns (unusual cross-tenant reads, mass PII access, after-hours bulk exports)
- Notification pipeline: DPO alert → Super Admin → regulatory bodies (per DPDP 72-hour rule)
- Breach register with immutable audit trail
- Drill playbook referenced from /docs/runbooks/breach-response.md

## P5.14: PR05 DPA & Sub-Processor Registry

Use the template. Module-specific notes:
- Vendor list per tenant with DPA version, signed date, compliance certifications
- Audit evidence storage (SOC 2 reports, ISO 27001 certs, DPAs)
- Sub-processor change notification workflow
- Surfaces in SCR-22 Compliance Operations

## P5.15: PR06 Retention Clock Service

Use the template. Module-specific notes:
- Retention policies defined per (purpose × data_category) in F04
- Clock ticks daily; data exceeding retention auto-erased (unless legal hold)
- Legal hold overrides retention; audit-logged
- Cascades across Postgres, BigQuery, GCS (tenant-prefixed paths)
- Per-record retention with bi-temporal awareness (F03)

---

## P5.16: RE01 Disaster Recovery & Business Continuity (NEW in v2)

**Spec reference:** §RE01
**Dependencies:** P0.3 (infra), P1.1 (F01)
**Output:** RPO/RTO targets, backup automation, DR drill runbook

```

Implement RE01 Disaster Recovery & Business Continuity per spec §RE01.

Scope:

1. RPO/RTO targets per tier:
   - Standard tier: RPO 24h, RTO 8h
   - Professional: RPO 4h, RTO 4h
   - Enterprise (Display Data): RPO 1h, RTO 2h
2. Automated backups:
   - Cloud SQL: automated daily + on-demand + PITR for Enterprise (7-day PITR retention)
   - GCS: object versioning + retention lock
   - Configuration (F04): git-backed version control
3. Cross-region replication for Enterprise tenants (asia-south1 → asia-south2)
4. Backup verification (automated): weekly restore-to-sandbox test for each backup tier
5. DR drill playbook — documented scenarios with step-by-step recovery at /docs/runbooks/dr-drill.md
6. Business continuity plan: communications, escalations, stakeholder notifications during incidents

Display Data is Enterprise tier — Enterprise RPO/RTO targets apply.

Integration: SCR-24 Platform Ops Dashboard (DR status widget, Phase 2), O02 (backup failure alerts)

Acceptance:

- Restore a test tenant from 24-hour-old backup in under 2 hours
- Backup verification test runs green weekly in CI-managed job
- DR drill playbook reviewed and signed off
- Commit as `feat(RE01): disaster recovery & business continuity`

```

---

## P5.17: IC01 retail vertical package content (NEW in v2)

**Spec reference:** IC01 §vertical packages; §"Screen Registry — Retail Vertical Default Configuration"
**Dependencies:** P5.2 (IC01 engine), P3.1 (D01)
**Output:** Full retail vertical package content

```

Author the retail vertical package as the first concrete instance of IC01.

Location: /services/industry/ic01/packages/retail/

Contents:

1. package.yaml — manifest with name, version, vertical_id, depends_on
2. screens.yaml — which SCR-xx and CX-xx screens are available in retail (per v2 spec §"Screen Registry — Retail Vertical Default Configuration")
3. entities.yaml — retail.\* entity extensions (links to D01 definitions in Part II)
4. kpis.yaml — the 2 funnels (Store Performance, Customer Lifecycle) with formulas and grains
5. hierarchy-template.yaml — the 5-level hierarchy (Chain → Region → City → Store → Zone)
6. alert-rules.yaml — retail default alert rules (OOS, basket drop, conversion drop, etc.)
7. consent-purposes.yaml — default retail consent purposes (service delivery, loyalty, marketing, analytics)
8. retention-policies.yaml — retail retention defaults (transactions 7y, customer data per DPDP, shelf images 90d)
9. connectors.yaml — retail-specific connector templates (POS formats, inventory sources)

This package is loaded by IC01 when a tenant provisions with vertical=retail.

Acceptance:

- Package loads cleanly via IC01 loader
- A newly provisioned retail tenant has all defaults applied
- Modifications to the package propagate via version bump + tenant acceptance flow
- Commit as `feat(IC01): retail vertical package content`

```

---

## P5.18: Display Data vertical extension package (NEW in v2)

**Spec reference:** §CX-DD-01 (vertical extension pattern)
**Dependencies:** P5.17 (retail package), P10.1 (agent runtime)
**Output:** Display Data extension on top of retail package

```

Author the Display Data vertical extension package.

Location: /services/industry/ic01/packages/display-data-extension/

Extends the retail package. Adds:

1. Additional screen: CX-DD-01 Shelf & Planogram Intelligence
2. Additional entities: retail.PlanogramCompliance, retail.ShelfObservation, retail.PromotionExecution
3. Additional KPIs: Planogram Compliance Score, OOS Facings, Promotion Execution Rate, Perishable Waste Rate, Assortment Completeness
4. Additional agents registered: Planogram, PAC, Promotion, Perishable (pipelines referenced from /agents/)
5. Additional alert rules: compliance score <80% critical, OOS facings >20 per store warning, perishable waste >threshold warning
6. Additional connectors: Ithina HHT app webhook, ROOS, ScanLink

Package manifest declares: extends=retail, version=0.1.0.

Loaded by IC01 when a tenant provisions with vertical=retail AND extension=display-data.

Acceptance:

- Package loads after retail package
- Display Data tenant has CX-DD-01 visible alongside CX-01, CX-02, CX-04
- Agent pipelines registered and runnable
- Commit as `feat(IC01): display data vertical extension package`

```

---

## P5.19: Standard error response format (NEW in v2)

**Spec reference:** Cross-cutting (CLAUDE.md convention)
**Dependencies:** P0.6
**Output:** @cortex/http-errors package + middleware

```

Implement the standard error response format every API must use.

Create /packages/http-errors:

- Typed error classes:
  ValidationError (400), AuthError (401), ForbiddenError (403), NotFoundError (404),
  ConflictError (409), BusinessRuleError (422), RateLimitError (429), InternalError (500)
- Error serializer middleware that transforms any thrown error to the standard shape:
  { code: string, message: string, correlation_id: string, details?: object }
- correlation_id sourced from observability context (request_id / trace_id)
- Production: masks internal details; Dev/staging: returns full details + stack
- Automatic structured log via @cortex/observability on every error response

Every backend service imports and uses this.

Convention documented at /docs/architecture/error-responses.md.

Acceptance:

- All error paths return the standard shape
- correlation_id in response matches trace ID in Cloud Trace
- Unit tests verify every error class serializes correctly
- Commit as `feat(http-errors): standard error response format`

```

---

## P5.20: Transactional email templates (NEW in v2)

**Spec reference:** O04 email connector consumer
**Dependencies:** P5.8 (O04 email connector), P1.4 (F04)
**Output:** Template system + Phase 1 templates

```

Build the transactional email template system on top of O04.

/packages/email-templates/

- MJML-based templates with variable interpolation
- Tenant-themed (uses F04 brand tokens)
- Locale-aware (uses IC02)
- Versioned with semver
- Preview endpoint for admin UI

Phase 1 templates required:

- user.invite — sent from SCR-02 when a user is invited
- user.password-reset — sent by AC01 forgot-password flow (or skipped if pure SSO)
- user.mfa-reset — sent by AC01 MFA reset flow
- alert.notification — sent by O02 when a routed alert fires
- provisioning.welcome — sent by W01 on tenant provisioning completion
- provisioning.step-reminder — sent by W01 when a tenant stalls mid-onboarding

Each template has: subject, body (MJML → HTML + plaintext), preview text.

Resend as email provider for Phase 1.

Acceptance:

- All 6 templates render correctly with Display Data branding
- Locale switch re-renders with translated strings (en-IN baseline; framework-ready for hi-IN)
- Test emails sent and delivery verified
- Commit as `feat(email-templates): phase 1 transactional templates`

```

---

# PART 6: FRONTEND FOUNDATION — UX01 SHELL

**Timing:** Week 7–9. Can parallel with backend P5.x.

---

## P6.1: Next.js monorepo structure + shared app shell

**Spec reference:** §UX01 §1.1
**Dependencies:** P0.1, P2.1 (AC01), P1.1 (F01)
**Output:** Both apps scaffolded with shared shell

```

Initialize /apps/admin-console and /apps/analytical as Next.js 15 (App Router) apps. Critical: both apps share the shell, the design system, the widget library, the auth flow, the tenant context. UX01 §1.1 calls this "a single Next.js application with two sections" — we'll implement it as two apps that share 90%+ code via packages.

Each app:

- Next.js 15 App Router
- TypeScript strict
- Tailwind consuming tokens from /packages/design-system
- Server Components for data-dense screens; Client Components only where interactivity is needed
- next-auth or auth middleware calling into AC01

Create /packages/ui-shell containing:

- AppShell component (sidebar + topbar + content area)
- Navigation (filtered by SCR registry per UX01-FR-002)
- TenantSwitcher, WorkspaceSwitcher
- UserMenu with MFA status, locale switcher (consuming IC02)
- BreadcrumbBar
- GlobalFilters (reusable filter row)
- CommandPalette (keyboard-driven nav)

Do NOT build any screens yet — only the shell, the routing skeleton, and a placeholder home page per app that says "Cortex admin-console (or analytical) — no screens registered yet."

Acceptance:

- Both apps build and run, serving their placeholder home with navigation shell
- Logging in as a dev user routes correctly
- Tenant switch propagates — URL query, context, API client all update
- Commit as `feat(ui-shell): admin + analytical app shells`

```

---

## P6.2: Design system & theme tokens

**Spec reference:** §UX01-FR-012, SCR-04
**Dependencies:** P1.4 (F04)
**Output:** /packages/design-system with tokens, typography, density modes

```

Build /packages/design-system.

Must be driven by CSS custom properties sourced from F04 per tenant — so any tenant rebrand (SCR-04) changes everything without code deploy.

Tokens:

- Colors: primary, accent, neutral-0 through neutral-1000, semantic (success, warning, danger, info)
- Typography: font family, scale (12/14/16/18/20/24/30/36/48), weights, line-heights
- Spacing: 4/8/12/16/24/32/48/64
- Radii: sm/md/lg/xl/full
- Shadows: sm/md/lg/xl/inner
- Z-indices: baseline, dropdown, modal, tooltip, toast
- Density modes: comfortable / compact / dense — different padding scales per mode

Tailwind config reads from the tokens via CSS vars so utility classes automatically respect theme.

Include typography components: Display, Heading, Subheading, Body, Label, Caption, Mono — all semantic and consistent.

Include a Storybook or Ladle instance at /packages/design-system/stories/ showing every token combination in every density mode and theme.

Acceptance:

- Switch theme in one tenant; every downstream widget reflects the change without rebuild
- Switch density mode; entire UI re-densifies
- Dark mode works out of the box
- Storybook renders all tokens and typography
- Storybook deployed to internal URL (GCS bucket + Cloud CDN) for design review
- Visual regression baseline captured (Chromatic or Percy); PR diffs against baseline
- Every component passes axe-core with zero WCAG 2.1 AA violations
- Commit as `feat(design-system): tokens + typography + density + storybook`

```

**Storybook convention (established here, required for all P7.x widgets):**
- Every widget has a Storybook file
- Every widget's states (loading, loaded, error, empty, masked, low-confidence) are stories
- Every widget's key config variations are stories
- Visual regression baseline at each Storybook story
- PR against main triggers Storybook rebuild and visual diff gate

---

## P6.3: UX01 Screen Registry consumer

**Spec reference:** §UX01-FR-001, UX01-FR-002, UX01-FR-003
**Dependencies:** P1.4 (F04), P6.1, P6.2
**Output:** Registry API consumer + navigation generator

```

Implement the Screen Registry consumer that drives navigation and routing per UX01-FR-002.

/packages/screen-registry/
src/
api.ts — fetches registry from F04
resolver.ts — intersects (vertical, tier, data sources, tenant overrides) → visible screens
navigation.ts — converts visible screens into grouped nav items
guards.ts — route guards: user navigates to a hidden screen → 403

Navigation sections: Home | Operate | Analyze | Configure | Govern | Admin (Sevyn8 only)

The resolver is the source of truth. Both the navigation component AND the route guards MUST consume the same resolver — UX01-FR-008 bans direct-URL access to hidden screens.

Acceptance:

- New tenant without an inventory source connected sees no "Inventory Intelligence" in the sidebar AND cannot reach /inventory via URL
- Connecting the inventory source makes the screen appear in the nav within 5 seconds (no page reload needed)
- Commit as `feat(screen-registry): ux01 screen registry consumer`

```

---

## P6.4: UX01 Layout Engine

**Spec reference:** §UX01-FR-020, UX01-FR-021, UX01-FR-023
**Dependencies:** P6.3
**Output:** Layout renderer, 12-col grid, refresh modes

```

Implement the Layout Engine that renders a JSON layout configuration into a 12-column responsive grid of widgets.

Layout JSON schema (UX01-FR-020):
{
screen_id, tenant_id, layout: { rows: [{ columns: [{ widget_id, widget_config, col_span }] }] },
filters: [{ filter_widget_id, position, cross_widget_binding }],
default_time_range, refresh_interval_seconds
}

Grid: 12 columns; widget col_span in {3, 4, 6, 12}; mobile stacks to 12.

Refresh modes (UX01-FR-023):

- Manual: user clicks refresh
- Interval: configurable (60s, 5min, 15min, 1hr)
- Event-driven: subscribe to Pub/Sub via WebSocket proxy

The Layout Engine does NOT know what widgets are — it just calls /packages/widgets with the widget_id and config. This decoupling is essential for UX01's "one codebase many products" goal.

Acceptance:

- Given a layout JSON and a widget library, the page renders
- Changing refresh mode triggers proper lifecycle
- Cross-widget filter binding: changing a date range filter updates all widgets on the page within 500ms
- Commit as `feat(layout-engine): ux01 12-col grid + refresh modes`

```

---

## P6.5: Widget Library scaffolding

**Spec reference:** §UX01-FR-010
**Dependencies:** P6.2, P6.4
**Output:** Widget base class, registration pattern, empty library

```

Scaffold /packages/widgets.

Every widget is a self-contained React component meeting UX01-FR-010:

- Accepts typed configuration object (Zod-validated)
- Fetches its own data from API gateway (O01)
- Respects tenant context, theme, locale, hierarchy scope, RBAC masking
- Handles loading / error / empty states
- Emits interaction events
- Carries a Data Quality Indicator per UX01-FR-013

Create base abstractions:

- <WidgetContainer> — wrapper that provides layout cell, loading/error boundaries, refresh control
- useWidgetConfig(schema) — validates config against Zod schema
- useWidgetData(queryKey, fetcher) — tanstack query wrapper with tenant/scope injection
- useWidgetEvents() — event emitter for cross-widget coordination
- <DataQualityBadge> — reads D04 score, renders HIGH/MEDIUM/LOW
- <PIIMask> — wraps values, reads AC01 mask directive, renders masked/unmasked

Widget registration: each widget exports a manifest { id, name, category, configSchema, component }. A central registry collects them. Layout Engine looks up by ID.

Do NOT build individual widgets yet — that's P7.

Acceptance:

- Base abstractions compile and have unit tests
- A stub widget "Hello World" renders via the Layout Engine given a layout JSON
- Commit as `feat(widgets): library scaffolding`

```

---

# PART 7: WIDGET LIBRARY — PHASE 1 WIDGETS

**Timing:** Week 8–10. These unblock the Phase 1 screens.

---

## P7.1: KPI Card widgets (all 5 variants)

**Spec reference:** §UX01-FR-011 KPI Cards row
**Dependencies:** P6.5
**Output:** Single metric, metric+trend, metric+sparkline, metric+comparison, traffic-light variants

```

Build the KPI card widget family.

Variants per spec:

- <SingleMetric config={ query, format }>
- <MetricWithTrend config={ query, trendPeriod, format }>
- <MetricWithSparkline config={ query, sparklinePeriod, format }>
- <MetricComparison config={ query, comparisonMode: 'vs-target' | 'vs-previous', format }>
- <TrafficLightMetric config={ query, thresholds: { red, amber, green }, format }>

All respect theme, locale formatting (IC02 — ₹1,00,000 not $100,000), data quality badge, RBAC masking.

Storybook coverage: every variant, every format (currency/percentage/count/duration), every state (loading/loaded/error/empty/low-confidence/masked).

Acceptance:

- Passes a visual regression test
- Renders correctly in Indian vs US locale
- Commit as `feat(widgets/kpi): kpi card family`

```

---

## P7.2: Chart widgets

**Dependencies:** P6.5
**Output:** Line, bar, stacked bar, area widgets using Recharts

```

Build chart widgets:

- <LineChart>
- <BarChart>
- <StackedBarChart>
- <AreaChart>

Each:

- Configurable axes, series, colors from theme tokens
- Click-to-drill action
- Time range selector
- Comparison overlay (vs previous period / vs target)
- Loading / error / empty states
- Locale-aware tick formatting

Use Recharts as the underlying library.

Acceptance: Commit as `feat(widgets/charts): phase 1 chart widgets`

```

---

## P7.3: Data table widget

**Dependencies:** P6.5
**Output:** Sortable, paginated, expandable-row table

```

Build <DataTable> widget per UX01-FR-011 Tables row.

Features:

- Columns from canonical schema
- Sort per column, filter per column
- Row click action
- Column masking (RBAC)
- Export CSV button (respects RBAC — EXPORT permission required)
- Inline sparklines per row where config specifies
- Pagination or virtualized scrolling
- Expandable rows with detail view

Use TanStack Table (React Table v8).

Acceptance: Commit as `feat(widgets/table): data table widget`

```

---

## P7.4: Filter widgets

**Dependencies:** P6.5, P2.2 (AC02 for hierarchy picker)
**Output:** Date range, hierarchy picker, multi-select, search bar, toggle

```

Build filter widget family per UX01-FR-011 Input/Filter row:

- <DateRangePicker> — presets (today/yesterday/MTD/QTD/YTD/last N days) + custom range
- <HierarchyPicker> — consumes AC02, respects scope, multi-level navigation
- <MultiSelect> — type-ahead with server-side options if >50 items
- <SearchBar> — debounced, deep-link updatable
- <Toggle>

All filters bind to cross-widget context per UX01-FR-020 filters clause.

Acceptance: Commit as `feat(widgets/filters): phase 1 filter widgets`

```

---

## P7.5: Entity Card widgets

**Dependencies:** P6.5
**Output:** Customer, store, product, alert, decision cards

```

Build entity card widgets per UX01-FR-011 Entity Cards row:

- <CustomerCard config={ entityId }> — loyalty tier badge, CLV, segment, last interaction
- <StoreCard>
- <ProductCard>
- <AlertCard>
- <DecisionCard>

Each fetches entity via canonical schema, respects PII masking, links to full detail screen (e.g., CustomerCard clicks to CX-03).

Acceptance: Commit as `feat(widgets/entity): entity card family`

```

---

## P7.6: Alerts Feed widget

**Dependencies:** P6.5, P5.7 (O02)
**Output:** Chronological alert list with actions

```

Build <AlertsFeed config={ source, priorityFilter }> per UX01-FR-011 Alerts & Actions row.

Features:

- Chronological list, deduplication (repeated alerts show count, not duplicate entries)
- Severity badge, type icon, title, timestamp, recommended action button
- Click row → focus in CX-04 Alert Centre
- Action button triggers A03 decision pipeline or O04 action
- Dismiss with reason

Acceptance: Commit as `feat(widgets/alerts): alerts feed widget`

```

---

## P7.7: Conversational widget (for CX-05 Ask Cortex, CX-DD-01 Ask PAC)

**Dependencies:** P6.5, P5.4 (A05)
**Output:** NL input + response card + explanation card

```

Build conversational widget family per UX01-FR-011 Conversational row:

- <NLQueryInput config={ llmModel, systemPrompt, schemaContext }>
- <AIResponseCard> — renders text + structured chart if applicable
- <ExplanationCard> — SHAP-style explanation rendering

Response UI must stream tokens (SSE) and fall back gracefully to non-stream if needed.

Include a "copy prompt" and "save as widget" affordance (the latter saves the generated query as a new widget via UX01 Dashboard Builder — stub if Dashboard Builder not yet built).

Acceptance: Commit as `feat(widgets/conversational): nl query family`

```

---

## P7.8: Proposal Inbox widget — CRITICAL, design spike first

**Dependencies:** P6.5
**Output:** Reusable approval-flow component for agent-generated proposals

```

**_ Before writing code: conduct a design spike. _**

The Proposal Inbox widget is consumed by SCR-09, SCR-10, SCR-11, SCR-12, SCR-16, CX-DD-01 for approving agent-generated proposals (mappings, DQ rules, identity merges, pipeline changes, purpose suggestions, agent findings). Getting the UX right ONCE here prevents six divergent approval UXs later.

Design spike:

1. Read the six consumer screen specs for their Proposal/Approval sections
2. Enumerate the common elements: proposal card → diff view → approve / reject / edit / defer → reason capture → audit log
3. Enumerate the divergent elements: what content renders in the diff per consumer
4. Write an ADR at /docs/architecture/decisions/ADR-proposal-inbox.md documenting the abstraction
5. Only then implement

Implementation:

- <ProposalInbox consumerType="mapping" | "dq_rule" | "identity_merge" | "pipeline" | "purpose" | "agent_finding" source={fetcher}>
- Standard approval actions; pluggable content area (the "diff" panel) per consumer type
- Bulk actions (approve all, reject all)
- Keyboard shortcuts (a/r/e/d)
- Audit log entry per action

Acceptance:

- ADR committed
- Widget handles all 6 consumer types without if-ladders
- Commit as `feat(widgets/proposal-inbox): reusable agent proposal approval`

```

---

## P7.9: Leaderboard / ranked table widget

**Dependencies:** P7.3
**Output:** Top-N / bottom-N variant of data table

```

Build <Leaderboard config={ query, topN, bottomN, rankBy }> per UX01-FR-011 Tables row ranked variant.

Used by CX-01 (top/bottom 10 stores), CX-08 (top products).

Acceptance: Commit as `feat(widgets/leaderboard): ranked table widget`

```

---

# PART 8: ADMIN CONSOLE — PHASE 1 SCREENS

**Timing:** Week 9–12. These are built after the widget library and deployed together as the Phase 1 release.

---

## P8.1: SCR-01 — Tenant Overview & Health

**Spec reference:** §SCR-01 (Part VII)
**Dependencies:** Widget library Phase 1, F01, F04, AC01, AC02, D04, O02, OB01, OB03
**Output:** Landing screen with health scorecard + activity feed + attention panel + quick links

```

Build SCR-01 per spec §SCR-01.

Read the spec section fully. Implement every FR-NNN requirement. Test against every acceptance criterion.

Layout:

- Row 1: Filters (tenant context — usually locked)
- Row 2: Health Scorecard — 5 cards (Platform / Ingestion / Quality / Consent / Usage) using <TrafficLightMetric>
- Row 3: Activity Feed (left 8-col) + Attention Panel (right 4-col)
- Row 4: Quick Actions bar

Health scores derived in near-real-time via WebSocket subscriptions to relevant Pub/Sub topics.

Cross-screen links per SCR-01-FR-002:

- Platform card → SCR-24
- Ingestion card → SCR-08 filtered to lagging source
- Quality card → SCR-10 filtered to failing dataset
- Consent card → SCR-16 filtered to gap purpose
- Usage card → SCR-21 filtered to metric approaching breach

Register the screen in the Screen Registry so it appears as default home for Tenant Admins.

Acceptance: every SCR-01 acceptance criterion verified by an E2E test (Playwright). Commit as `feat(SCR-01): tenant overview & health`

```

---

## P8.2: SCR-02 — Users, Teams & Workspaces

**Spec reference:** §SCR-02
**Dependencies:** F01, AC01, AC02, PR02
**Output:** User directory + invite flow + teams + workspaces + SCIM + SSO

```

Build SCR-02 per spec §SCR-02.

Scope:

- User directory with status, roles, hierarchy scope, MFA, workspaces, last-login
- Invite flow with branded email (using SCR-04 brand tokens)
- Bulk CSV import with validation
- Teams CRUD (logical groupings, not permissions)
- Workspaces CRUD (sub-tenant boundaries) — **CRITICAL: supports multi-workspace from day one per Display Data configuration**
- SSO config (SAML/OIDC) for Enterprise
- SCIM 2.0 endpoint for Okta/Azure AD/Google Workspace inbound provisioning
- Disable/delete with DSAR routing

Acceptance: every SCR-02 acceptance criterion verified. Commit as `feat(SCR-02): users, teams & workspaces`

```

---

## P8.3: SCR-04 — Tenant Configuration & Theme

**Spec reference:** §SCR-04
**Dependencies:** F04, IC02, UX01
**Output:** Brand editor, locale/region, custom domain (Enterprise), screen toggles, feature flags

```

Build SCR-04 per spec §SCR-04.

CRITICAL feature for Display Data: custom domain configuration must work end-to-end. Display Data will launch on a custom domain at go-live.

Scope:

- Brand editor with live preview (re-renders SCR-01 as preview target)
- Accessibility validator (WCAG 2.1 AA contrast check on save)
- Locale editor (en-IN default, framework-ready for hi-IN/ta-IN)
- Custom domain wizard (CNAME validation + TLS via Google-managed cert)
- Email from-address with SPF/DKIM verification
- Screen availability toggles (consumes Screen Registry)
- Feature flags (tenant-scoped)
- Draft → validate → promote → rollback flow

Acceptance: every SCR-04 acceptance criterion; custom domain for a test tenant provisions end-to-end in <15 min. Commit as `feat(SCR-04): tenant config & theme`

```

---

## P8.4: SCR-05 — Hierarchy Manager

**Spec reference:** §SCR-05
**Dependencies:** AC02, F03
**Output:** Interactive tree + bulk CSV + reorg scheduling + multi-hierarchy

```

Build SCR-05 per spec §SCR-05.

Scope:

- Interactive hierarchy tree (expand/collapse, drag-to-reparent, inline rename, right-click actions)
- Bulk CSV import with cycle/orphan/type validation
- Search (name, code, metadata, breadcrumb results)
- Scheduled reorganizations (draft + effective date + validate + commit)
- Version diff side-by-side
- Multi-hierarchy support (operations / reporting / logistics)
- Cross-hierarchy mapping overlay

Acceptance: every SCR-05 acceptance criterion — 500-store bulk import in <1hr; reorg of 30 stores in <1 minute; historical hierarchy queries correct. Commit as `feat(SCR-05): hierarchy manager`

```

---

## P8.5: SCR-06 — Role & Permission Manager

**Spec reference:** §SCR-06
**Dependencies:** AC01
**Output:** Platform role view + custom role authoring + permission matrix + simulator + impact

```

Build SCR-06 per spec §SCR-06. Scope per FR-NNN. Include the Policy Simulator (SCR-06-FR-005) — it's the debugging tool admins will rely on.

Acceptance: every criterion. Commit as `feat(SCR-06): role & permission manager`

```

---

## P8.6: SCR-07 — Canonical Schema Browser

**Spec reference:** §SCR-07
**Dependencies:** D01, D03, F05, D05, IC01
**Output:** Three-tier ontology browser, relationship graph, KPI glossary, schema evolution timeline

```

Build SCR-07 per spec §SCR-07.

Scope per FR-NNN:

- Navigable tree across Core → Vertical → Tenant Extension tiers
- Entity detail page with attributes table, relationships diagram, source mappings, downstream usage
- Search (attribute, entity, description, tag, semantic)
- Relationship graph (interactive Cytoscape.js) with focus mode
- KPI glossary linked inline from dashboards
- Schema evolution timeline per entity type
- Tenant extension draft/approve flow (Enterprise)

Acceptance: every criterion. Commit as `feat(SCR-07): canonical schema browser`

```

---

## P8.7: SCR-08 — Data Source Wizard & Ingestion Health

**Spec reference:** §SCR-08 — highest priority operational cockpit for DIS
**Dependencies:** G01, G02, D02, D04, D05
**Output:** Full operational cockpit — catalog + wizard + source detail + runs + inspector + DLQ + replay + live tail + drift

```

Build SCR-08 per spec §SCR-08.

**This is the most-used screen for Display Data operators. Quality matters most here.**

Scope (every FR):

- Source catalog with live health cards
- Add Source Wizard (7-step per FR-003): type → connection → schema preview → ingestion policy → consent → PII classification → activation
- 11 connector types supported at launch
- Source detail with schedule, SLA, PII inventory, related mappings, runbook URL
- Runs list with 10-state machine position
- Run detail with 7-stage drilldown
- Record Inspector (Bronze/Silver/Gold side-by-side) — **critical for Display Data debugging**
- DLQ / Quarantine view with reason codes + fix affordances
- Replay Console (time-window, targeted, DLQ-replay)
- Live Tail via WebSocket
- Health Metrics dashboard
- Schema Drift Alerts

Special attention for Display Data use cases:

- ROOS connector works end-to-end
- ScanLink connector works end-to-end
- Manual CSV upload via Universal CSV Ingestion Agent works (integrate existing agent_011Ca2AxDuF5UDLWSAac5tGM — see /docs/progress for Phase 1 integration notes)
- Shelf imagery ingestion from HHT app works (the Ithina React Native HHT app produces image uploads; SCR-08 surfaces these as a source)

Acceptance: every SCR-08 acceptance criterion. Commit as `feat(SCR-08): data source wizard & ingestion health`

```

---

## P8.8: SCR-09 — Mapping Studio

**Spec reference:** §SCR-09
**Dependencies:** D02, D03, D01, A05 (agent proposals), P7.8 (Proposal Inbox widget)
**Output:** Mapping workspace + transformation language + agent proposals + versioning

```

Build SCR-09 per spec §SCR-09.

Scope per every FR:

- Mapping workspace: source schema (left) + canonical schema (right) + rules canvas (middle)
- Rule types: rename, coerce, transform (expression), conditional, split, combine, constant, enum, pass-through
- Transformation language: restricted sandboxed JS-like; standard library (date, string, phone, email, GTIN, currency via IC02, hash, lookup)
- Live preview (sample row → canonical output + validation)
- Agent-proposed mappings via Proposal Inbox widget — **first consumer of P7.8**. D02 auto-mapping and CSV Ingestion Agent proposals land here.
- Mapping versions as D03 contracts with commit messages, diffs, downstream impact
- Test harness (run proposed contract against last 1000 records, block if failure >1%)
- One-click rollback

Acceptance: every SCR-09 acceptance criterion including <15 min mapping time for 30-column CSV with agent assist, and >90% auto-propose accuracy at HIGH/MEDIUM confidence. Commit as `feat(SCR-09): mapping studio`

```

---

## P8.9: SCR-10 — Data Quality Console

**Spec reference:** §SCR-10
**Dependencies:** D04, D05, O02, P7.8
**Output:** Quality scorecard + rules library + incident stream + DQ agent proposals + promotion gates

```

Build SCR-10 per spec §SCR-10.

Every FR. Uses Proposal Inbox widget for DQ Agent rule proposals.

Acceptance: every criterion including deterministic incident → root-cause navigation in ≤3 clicks. Commit as `feat(SCR-10): data quality console`

```

---

## P8.10: SCR-16 — Consent Manager (Phase 1 cut)

**Spec reference:** §SCR-16
**Dependencies:** AC03, PR01, PR04, PR06, AC04
**Output:** Purpose registry + consent state overview + per-entity consent + collection config + withdrawal cascade

```

Build SCR-16 per spec §SCR-16.

Phase 1 cut: Purpose Registry, Consent State Overview, Per-Entity Consent, Consent Collection Configuration (templates), Withdrawal Cascade Monitor, Retention Dashboard.

Defer to Phase 2: DPIA workflow UI (PR04), Consent Reporting exports.

Body Shop two-touchpoint model MUST work in Phase 1 since they go live on it.

Acceptance: every criterion that applies to Phase 1 scope. Commit as `feat(SCR-16): consent manager (phase 1 cut)`

```

---

## P8.11: SCR-19 — Notification & Alert Rules

**Spec reference:** §SCR-19
**Dependencies:** O02, AC02, S17 (stub for Phase 1 routing channels), SCR-18 webhooks
**Output:** Rule authoring + routing + escalation + digest/quiet hours + analytics

```

Build SCR-19 per spec §SCR-19.

Acceptance: every criterion. Commit as `feat(SCR-19): notification & alert rules`

```

---

## P8.12: SCR-20 — Audit & Activity Log (with Lineage)

**Spec reference:** §SCR-20
**Dependencies:** D05, A07 (stub ok for Phase 1), AC01, every auditable module
**Output:** Unified audit feed + lineage explorer + decision log + integrity proofs + sensitive event highlighting

```

Build SCR-20 per spec §SCR-20.

**Critical compliance screen — regulator-visible. Get the integrity guarantees right (SHA-chain, signed exports).**

Acceptance: every criterion including <5s from admin action to appearance in S20; SHA-chain tamper detection within 5 min. Commit as `feat(SCR-20): audit & activity log`

```

---

## P8.13: SCR-24 — Platform Ops Dashboard (Phase 1 minimal cut) (NEW in v2)

**Spec reference:** §SCR-24 (Phase 1 cut only — tenant provisioning wizard and tenant listing)
**Dependencies:** F02, AC01, IC01, P5.17, P5.18
**Output:** Minimal SCR-24 covering what CSM needs for Display Data rollout

```

Build a minimal Phase 1 cut of SCR-24 Platform Ops Dashboard.

Full SCR-24 is Phase 2 (P12.12). The Phase 1 cut covers ONLY what's needed for Display Data CSM to provision and operate the tenant:

Phase 1 scope:

- Tenant list table (every tenant, status, tier, vertical, created date, last activity)
- Tenant provisioning wizard (triggers F02 provisioning, pre-configures vertical + extension + tier + region)
- Tenant detail view (read-only) showing current status and the tenant's W01 progress
- Tenant suspension and offboarding initiation
- SSO provider configuration per Enterprise tenant (hands to AC01 SSO config)

Deferred to Phase 2 (stubs only):

- Cross-tenant query tools
- Incident response tools
- Platform-wide health dashboard
- Billing/revenue views
- Telemetry rollup from W01 (surfaced in Phase 2)

Only Sevyn8 Super Admins have access (AC01 policy).

Provisioning wizard flow:

1. Tenant basics (name, primary contact email, tier, region)
2. Vertical + extension (retail, retail+display-data, reinsurance, etc.)
3. Custom domain (Enterprise) — validates CNAME + provisions TLS
4. Initial admin invitation (triggers W01 on their first login)
5. Confirm → F02 provisioning kicks off asynchronously with progress events

Acceptance:

- CSM can provision Display Data via wizard in <10 min
- Tenant list supports sort/filter/search
- Suspension cascades correctly (revokes sessions, halts ingestion)
- Commit as `feat(SCR-24): platform ops dashboard (phase 1 cut)`

```

---

## P8.14: W01 — Tenant Onboarding Wizard

**Spec reference:** §W01
**Dependencies:** F02, F04, IC01, AC01, SCR-02, SCR-04, SCR-05, SCR-08, SCR-16
**Output:** 10-step onboarding flow, re-entrant, multi-workspace support from day one

```

Build W01 per spec §W01.

**CRITICAL for Display Data — this is the FIRST thing Display Data's Tenant Admin will experience at go-live.**

Scope per every FR:

- Step 1: Welcome & Tenant Context (vertical pre-selected by CSM via SCR-24)
- Step 2: Brand & Theme (hands to SCR-04)
- Step 3: Custom Domain (Enterprise) — **Display Data will use this**
- Step 4: Hierarchy (hands to SCR-05)
- Step 5: User Invitation (hands to SCR-02)
- Step 6: Workspace Structure — **Display Data is multi-workspace from day one; this step captures initial downstream Ithina retail client workspaces**
- Step 7: First Data Source (hands to SCR-08)
- Step 8: Consent Purposes (hands to SCR-16)
- Step 9: First Dashboard verification (confirm CX-01 loads with data)
- Step 10: Next Steps checklist (persists in SCR-01 Attention Panel)

W01 is re-entrant — admin can revisit any step anytime via direct nav.

Wizard telemetry feeds SCR-24 with step durations, drop-offs, friction points (anonymized across tenants).

Acceptance: Standard-tier tenant completes E2E in <2hr; Enterprise in <4hr; Display Data's configuration goes through without manual CSM intervention. Commit as `feat(W01): tenant onboarding wizard`

```

---

# PART 9: ANALYTICAL SCREENS — PHASE 1

**Timing:** Week 11–13. Parallel with agent work (Part 10).

---

## P9.1: CX-01 — Executive Dashboard

**Spec reference:** §CX-01 (master spec, Part VI)
**Dependencies:** D01 Gold-layer KPIs, D04 quality, O02 alerts, AC02 hierarchy, IC02 locale, widget library
**Output:** Home screen for CEO/VP/Regional/Store Manager

```

Build CX-01 per spec §CX-01.

Layout per spec:

- Row 1: Global filters (date range + hierarchy picker + comparison toggle)
- Row 2: 4 KPI cards (Revenue, Transactions, Avg Basket Value, Conversion Rate)
- Row 3: Revenue trend line (6-col) + Store leaderboard (6-col)
- Row 4: Customer segment donut (4-col) + Top products bar (4-col) + Alerts feed (4-col)
- Row 5: 4-week WoW change table

Interactions per spec (click-through to CX-02, CX-06, CX-04 etc.).

Hierarchy scope from AC02 auto-applied — CEO sees chain, store manager sees store.

Acceptance: p95 load <1.5s with 100-store tenant. Commit as `feat(CX-01): executive dashboard`

```

---

## P9.2: CX-02 — Store Performance

**Spec reference:** §CX-02
**Dependencies:** D01, AC02, (G04 optional for zone analytics), widget library
**Output:** Store funnel + hourly heatmap + zone analytics + store comparison

```

Build CX-02 per spec §CX-02.

Layout per spec with graceful fallback when G04 video not available (funnel starts at Transactions instead of Footfall, floor plan view replaced by department performance table).

Commit as `feat(CX-02): store performance`

```

---

## P9.3: CX-04 — Alert Centre

**Spec reference:** §CX-04
**Dependencies:** O02, A03 (stub ok), AC02, D04
**Output:** Alert summary + feed + trends + resolution metrics

```

Build CX-04 per spec §CX-04.

Commit as `feat(CX-04): alert centre`

```

---

## P9.4: CX-DD-01 — Shelf & Planogram Intelligence (Display Data primary analytical screen)

**Spec reference:** §CX-DD-01 (Part VIII)
**Dependencies:** D01, G04, G06, AC02, all four Ithina agents (Part 10), FB02, Proposal Inbox widget
**Output:** Display Data's primary screen — compliance heatmap + agent findings feed + execution trends + shelf image gallery + perishable tracking + Ask PAC

```

Build CX-DD-01 per spec §CX-DD-01.

**This is Display Data's flagship screen. It must be excellent.**

Layout per spec:

- Row 1: Filters (date, store, category, planogram version)
- Row 2: 4 KPI cards (Planogram Compliance Score / OOS Facings / Misplaced SKUs / Promotion Execution Rate)
- Row 3: Planogram Compliance Heatmap (full width, clickable cells)
- Row 4: Agent Findings Feed (6-col) + Execution Trends (6-col)
- Row 5: Shelf Image Gallery (full width, annotated)
- Row 6: Perishable Waste Tracking (conditional — only if perishables in catalog)

Critical integrations:

- Agent Findings Feed is the live output of PAC, Promotion, Planogram, Perishable agents via their decision pipelines (SCR-12-based)
- "Ask PAC" is a conversational widget with agent-specific system prompt (scoped A05 context)
- Click-to-task from findings routes via O04 through SCR-17

Register in the Display Data vertical extension package in IC01 so only Display Data and its downstream Ithina retail clients see this screen.

Acceptance per spec: p95 <2s with 100 stores/10K SKUs; findings appear within 5min of capture. Commit as `feat(CX-DD-01): shelf & planogram intelligence`

```

---

# PART 10: ITHINA AGENTS

**Timing:** Week 12–14, parallel with CX-DD-01.

**Critical context:** The 4 Ithina agents are Display Data's core IP. Build them as proper SCR-12 decision pipelines from day one so they compound into Cortex as reusable assets, not one-off scripts.

---

## P10.1: Agent runtime foundation

**Spec reference:** §A03 Decision Orchestration, §SCR-12
**Dependencies:** A03, A05, A06, A01 (stub), A07 (stub), AC02, FB02 (stub)
**Output:** Pipeline DAG executor + node type framework

```

Build the agent runtime foundation at /services/ai/a03-decision-orchestration/.

This is NOT the pipeline BUILDER UI (that's SCR-12, Phase 2). This is the RUNTIME that executes decision pipelines authored for Display Data's four agents.

Scope:

- DAG executor with typed node types:
  - Trigger (Pub/Sub subscription)
  - DataSourceLookup
  - FeatureLookup (A01 stub)
  - AlgorithmInvocation
  - RuleNode (A06)
  - LLMNode (A05) with prompt template
  - HumanApprovalGate (persists to review queue)
  - Branching (conditional routing)
  - ActionEmit (to O04)
  - Terminal

- Input/output schema validation between nodes at design-time (load-time for this Phase)
- Pipeline versioning (champion/challenger/shadow/retired)
- Per-pipeline metrics (execution count, p50/p95/p99 latency, success rate, decision distribution)
- Outcome linkage stub (FB02 hook) — actual FB02 implementation is Phase 2

Pipelines defined as YAML files in /agents/{agent_name}/pipelines/ initially (SCR-12 DAG editor will target these later).

Acceptance:

- A trivial "hello world" pipeline (Trigger → LLMNode → ActionEmit) runs end-to-end
- Pipeline simulator runs a draft without production side effects
- Commit as `feat(A03): agent runtime foundation (pipeline executor)`

```

---

## P10.1a: Model Registry Light (NEW in v2)

**Spec reference:** Placeholder for A04 Model Lifecycle Manager (Phase 2)
**Dependencies:** P10.1 (agent runtime), P0.3 (GCS)
**Output:** Minimal model registry until A04 Phase 2

```

Build a lightweight model registry to serve Phase 1 agents until A04 Model Lifecycle Manager is built in Phase 2.

/services/ai/model-registry-light/

- Model record: { model_id, agent_name, version, training_run_id, accuracy_baseline, storage_uri (GCS), status (STAGED/CHAMPION/RETIRED), promoted_at, promoted_by }
- GCS bucket for model artifacts (ONNX format preferred for portability)
- Simple API: register(), list(), getChampion(agent), promote(modelId), rollback(agent)
- Audit every promotion per P0.10 convention
- Integrates with @cortex/feature-flags for gradual rollout (champion/challenger)

Migration path: when A04 lands in Phase 2, these records migrate to A04 with no data loss.

Model deployment pattern for agents:

- Agent pipelines reference model by agent_name (not version)
- Runtime resolves to current champion at execution time
- Rollback by promoting the previous champion

Acceptance:

- Register a YOLO model for Planogram agent; it becomes champion
- Register a new version; explicitly promote; Planogram agent uses new version within 1 minute
- Rollback works; old version used again
- Commit as `feat(model-registry-light): lightweight registry for phase 1 agents`

```

---

## P10.2: Planogram Agent

**Spec reference:** §CX-DD-01; Ithina proposal materials in /docs/clients/display-data/
**Dependencies:** P10.1, G04 (video pipeline — stub for Phase 1 with uploaded images), D01 retail.Planogram, D01 retail.Shelf
**Output:** Planogram compliance detection pipeline

```

Build the Planogram Agent — start here because it's the most fundamental Display Data capability.

Read /docs/clients/display-data/ for the full context on the planogram use case, what Ithina's clients expect, how the agent fits into the client workflow.

The agent is a decision pipeline:
Trigger: new shelf image ingested (from HHT app or fixed camera) via G01 → G04 (stubbed for Phase 1 to accept uploads via SCR-08)
→ DataSourceLookup: current active retail.Planogram for (store, shelf, category)
→ AlgorithmInvocation: object detection model (YOLO-based, per the Sevyn8 YOLO decision) identifies products on shelf
→ AlgorithmInvocation: compliance comparison — observed vs expected planogram; compute compliance score, identify misplaced SKUs, missing SKUs, wrong-facing-count
→ LLMNode: generate human-readable finding description with recommended action
→ RuleNode: severity classification based on sales impact estimate
→ ActionEmit: write finding to retail.PlanogramCompliance entity; emit to Pub/Sub for CX-DD-01 feed; if severity=HIGH, fire alert to O02

Model: use Ultralytics YOLO variant trained on retail shelf data. Initial fine-tuning from Ithina's existing annotated data. Inference in ONNX Runtime for portability.

Data model additions (extend D01):

- retail.PlanogramCompliance (entity per (store, shelf, timestamp) with compliance_score, findings, image_ref)
- retail.ShelfObservation (raw CV output per image)

Per the Sevyn8 skill's voice: agent findings are direct, factual, with impact estimates in INR. No marketing fluff.

Acceptance:

- Given 10 annotated test images, agent produces correct compliance scores within 20% of human annotation
- End-to-end latency (image upload → finding in CX-DD-01) <5 minutes
- Commit as `feat(agents/planogram): planogram compliance agent`

```

---

## P10.3: PAC Agent (Product/Assortment Compliance)

**Dependencies:** P10.2 (shares CV foundation)
**Output:** Assortment compliance pipeline

```

Build the PAC Agent (Product/Assortment Compliance).

Pipeline:
Trigger: daily schedule (or on-demand)
→ DataSourceLookup: expected assortment (SKU list) per (store, category) from client's master data
→ DataSourceLookup: observed stock levels per SKU (from POS data + recent shelf observations)
→ AlgorithmInvocation: compute assortment gap (expected - observed); classify each gap (out-of-stock, delisted, never-stocked, under-stocked)
→ LLMNode: generate store-level assortment report, prioritized by revenue impact
→ ActionEmit: write findings; publish to CX-DD-01 and O02 alerts

Acceptance:

- Correctly identifies 95% of assortment gaps in validation dataset
- Commit as `feat(agents/pac): product/assortment compliance agent`

```

---

## P10.4: Promotion Agent

**Dependencies:** P10.2
**Output:** Promotional display compliance pipeline

```

Build the Promotion Agent.

Pipeline:
Trigger: new shelf image OR start of new promotion period
→ DataSourceLookup: active retail.Promotion records for (store, category, date)
→ AlgorithmInvocation: detect promotional signage, promotional pricing tags, end-cap displays, bundle displays in image
→ AlgorithmInvocation: compare detected vs expected promotion execution
→ LLMNode: generate finding per promotion: is it displayed correctly, are signs up, are prices right, is stock present at display
→ ActionEmit: findings per promotion; ROI-at-risk estimate

Acceptance: Commit as `feat(agents/promotion): promotion execution agent`

```

---

## P10.5: Perishable Agent

**Dependencies:** P10.1
**Output:** Perishable freshness + markdown suggestion pipeline

```

Build the Perishable Agent.

Pipeline:
Trigger: hourly schedule (perishables move fast)
→ DataSourceLookup: perishable SKUs with received dates and sell-by dates (from inventory ingestion)
→ AlgorithmInvocation: demand forecast per SKU per store (A02 if available, else exponential smoothing baseline)
→ AlgorithmInvocation: predicted unsold quantity by sell-by date
→ RuleNode: classify as (will-sell-fine / at-risk / needs-markdown / mark-down-now / write-off-imminent)
→ LLMNode: generate recommendations with specific markdown amounts and forecasted sell-through under the markdown
→ ActionEmit: findings to CX-DD-01; alerts via O02 for urgent items

Acceptance: Commit as `feat(agents/perishable): perishable freshness + markdown agent`

```

---

## P10.6: Agent testing harness + synthetic data

**Dependencies:** P10.1 through P10.5
**Output:** Reproducible test fixtures + accuracy benchmarks per agent

```

Build an agent testing harness.

Scope:

- Synthetic shelf image generator (annotated) for Planogram / PAC / Promotion agents
- Synthetic POS + inventory data generator for Perishable agent
- Baseline accuracy benchmarks: each agent runs against a fixed test set; accuracy tracked per commit in CI
- Regression detection: if accuracy drops >3% from baseline, PR is blocked

Acceptance: Running `make test-agents` produces a report showing accuracy per agent against the baseline. Commit as `feat(agents): testing harness + synthetic data`

```

---

## P10.7: Universal CSV Ingestion Agent integration (NEW in v2)

**Spec reference:** SCR-08 and SCR-09 consumer; agent_011Ca2AxDuF5UDLWSAac5tGM origin
**Dependencies:** P8.7 (SCR-08), P8.8 (SCR-09), P5.4 (A05)
**Output:** Self-hosted CSV agent on Cloud Run + SCR-08/09 plumbing

```

Integrate the existing Universal CSV Ingestion Agent (agent_011Ca2AxDuF5UDLWSAac5tGM) into the Cortex platform.

The agent was previously built on Anthropic's Managed Agents platform. For Phase 1, we want it self-hosted on Cloud Run so it's in the Cortex trust boundary.

Work streams:

1. Export agent definition from Managed Agents (tool definitions + prompt templates + agentic loop)
2. Port to /services/ai/csv-ingestion-agent/ as a standalone Node service
3. Expose HTTP endpoint: POST /agent/csv-ingest with { tenantId, fileRef, sourceHint }
4. Agent invokes A05 LLM Gateway for reasoning (not direct Anthropic API)
5. SCR-08 manual upload flow invokes this agent on any CSV upload
6. Agent produces: domain detection, column profile, cleaning operations, validation report, proposed D02 mapping, proposed D03 contract, proposed PostgreSQL DDL
7. All outputs route to SCR-09 Mapping Studio as proposals (via Proposal Inbox widget from P7.8)

Versioning: agent version tagged; SCR-08 records which version produced a given proposal for reproducibility. Feature flag `ingestion.csv-agent-v2` controls which version is active.

Acceptance:

- Upload a messy CSV via SCR-08 → within 2 min, proposals appear in SCR-09 Mapping Studio Proposal Inbox
- Agent version recorded per proposal
- Data steward can approve/edit/reject proposals
- Commit as `feat(agents/csv-ingestion): port + integrate universal csv agent`

```

---

# PART 11: DIS END-TO-END FOR DISPLAY DATA

**Timing:** Week 13–14. The moment of truth — is everything we built actually working?

---

## P11.1: Provision Display Data tenant in staging

**Dependencies:** P1.2 (F02), P8.13 (W01), Parts 8–10 complete
**Output:** Live Display Data tenant with all agreed config

```

Provision the Display Data tenant in the staging environment per the v2 spec commitment:

- Enterprise tier (dedicated Cloud SQL)
- Region asia-south1 primary, asia-south2 DR
- Vertical: retail + Display Data extension package (IC01)
- Multi-workspace from day one with initial workspaces representing first Ithina downstream retail clients (placeholder names OK if real clients not locked)
- Custom domain (use staging subdomain — e.g., staging-insights.ithina.com — real domain comes in production provisioning)

Walk the provisioning through SCR-24 using the Super Admin wizard. Complete W01 to the end. Verify all 10 steps complete without manual intervention.

Acceptance:

- Display Data admin can log in, sees branded console, all configured screens visible
- Workspaces list shows initial downstream clients
- Audit log (SCR-20) shows all provisioning events
- Commit as `ops(display-data): staging tenant provisioned`

```

**Additional post-provisioning seed script (NEW in v2):**

After W01 completes, run /scripts/display-data/seed-defaults.ts to populate Display Data's operational defaults that W01 doesn't capture:

```

/scripts/display-data/seed-defaults.ts seeds:

1. Hierarchy placeholders:
   - Display Data (Chain)
   - [Initial Workspace 1] → Region A → City X → Stores A1, A2, A3
   - [Initial Workspace 2] → (similar structure)

2. Default alert rules (SCR-19):
   - Planogram Compliance <80% → CRITICAL
   - OOS Facings >20 per store per day → HIGH
   - Perishable Waste >threshold per store per week → MEDIUM
   - Agent Pipeline Failure Rate >5% → HIGH
   - Ingestion Lag >2x baseline → MEDIUM

3. Default dashboard layouts:
   - CX-DD-01 as Display Data user default home
   - CX-01, CX-02, CX-04 enabled

4. Default retention policies (per Display Data tier + DPDP):
   - Shelf images (retail.ShelfObservation.image_ref): 90 days
   - PlanogramCompliance findings: 7 years
   - POS data: 7 years
   - Audit events: 7 years
   - User activity logs: 2 years

5. Default consent purposes (B2B context):
   - Service Delivery (contractual basis)
   - Analytics (derived metrics only, no PII)
   - Future-ready placeholder for downstream retail customer data

6. Default channel config (O04):
   - Email from-address configured per SCR-04 custom domain
   - Webhook placeholder: disabled until downstream client webhook URL known

Defaults captured in /docs/progress/display-data-defaults.md for reuse by future vertical tenants.

Commit as `ops(display-data): default seeds for staging provisioning`

```

---

## P11.2: First real data source — shelf imagery from HHT app

**Dependencies:** P11.1, P4.4 (G01), P8.7 (SCR-08)
**Output:** Live shelf imagery ingestion → CX-DD-01

```

Wire the Display Data tenant's first real data source: shelf imagery uploaded from the Ithina React Native HHT app.

Configuration in SCR-08:

- Source type: HTTPS webhook
- Endpoint: provided to HHT app at config time
- Auth: API key scoped to Display Data's first workspace
- Schema: image metadata (store_id, shelf_id, captured_at, captured_by, device_id) + image blob (deposits to GCS staging-cortex-bronze/tenants/display-data/shelf-images/)

Mapping in SCR-09: maps to retail.ShelfObservation entity + raw image in GCS.

Verify end-to-end:

1. HHT app (test harness if real app not ready) uploads a shelf image
2. G01 ingests; image lands in Bronze
3. G02 processes to Silver with metadata in Postgres
4. Planogram Agent picks up via Pub/Sub trigger, runs pipeline, writes finding to retail.PlanogramCompliance
5. Finding surfaces in CX-DD-01 within 5 minutes

Acceptance:

- E2E pipeline works with <5 min latency
- Errors at any stage surface as DLQ entries in SCR-08 with actionable reason codes
- Commit as `ops(display-data): shelf imagery pipeline live in staging`

```

---

## P11.3: Second data source — POS data

**Dependencies:** P11.2
**Output:** POS data ingestion → CX-01 + CX-02 + CX-DD-01 Perishable agent

```

Wire POS data ingestion (SFTP drop folder pattern is common for retail POS).

Configuration per SCR-08 + SCR-09. Validate:

- Transactions land in retail.Transaction
- Line items land in retail.TransactionLineItem
- CX-01 Executive Dashboard shows numbers for Display Data's downstream client
- CX-02 Store Performance works
- Perishable Agent receives inventory + POS signal, starts producing findings

Acceptance:

- Daily POS drop (sample file) processes in <30 minutes end-to-end
- CX-01 populated with real numbers
- Commit as `ops(display-data): POS ingestion live in staging`

```

---

## P11.4: Full E2E validation

**Dependencies:** P11.1 through P11.3, all agents (Part 10)
**Output:** Full smoke test of Phase 1 deployment

```

Conduct a full end-to-end validation of the Display Data Phase 1 deployment in staging.

Validation checklist:

1. Provisioning (W01 complete)
2. All 13 Phase 1 admin screens reachable, RBAC correct per role
3. All 4 Phase 1 analytical screens (CX-01, CX-02, CX-04, CX-DD-01) rendering with real data
4. Shelf imagery pipeline <5min E2E latency, p95
5. POS ingestion <30min batch latency, p95
6. All 4 agents producing findings within expected latency
7. Alerts firing and routing correctly per SCR-19 rules
8. Audit log (SCR-20) capturing every admin action
9. Consent cascade tested (withdraw consent for a test entity, verify 15-min/1-hr/24-hr SLAs met)
10. Custom domain TLS working
11. Multi-workspace switch between the 2+ downstream client workspaces works cleanly
12. CSV download from any table respects RBAC
13. Error states graceful — simulated upstream outages don't break UI
14. Load test: 1000 concurrent users, 10K events/min ingestion sustained for 1 hour

Produce a validation report at /docs/progress/display-data-e2e-validation-[YYYY-MM-DD].md listing every item, pass/fail, evidence (screenshots, log excerpts, metric panels).

Any failures block production rollout.

Commit as `docs(display-data): phase 1 e2e validation report`

```

---

## P11.5: Backup restoration drill (NEW in v2)

**Spec reference:** RE01 acceptance criteria
**Dependencies:** P5.16 (RE01), P11.4 (E2E validation)
**Output:** Verified restoration of a real backup

```

Before declaring Phase 1 ready for production, execute a backup restoration drill.

Scenario:

1. Take a point-in-time snapshot of the staging Display Data tenant
2. Note key reference values:
   - A transaction total
   - A KPI score (compliance, OOS count, etc.)
   - Hierarchy state (specific workspace and store entries)
   - A PlanogramCompliance record
3. Simulate loss: destroy the staging Cloud SQL instance
4. Restore from backup into a new instance
5. Verify every reference value matches the pre-loss state
6. Measure actual RTO — should be <2h for Enterprise (Display Data's tier)
7. Verify RPO — data loss window should be <1h

Produce /docs/progress/backup-drill-[YYYY-MM-DD].md with timing, issues encountered, lessons.

If RTO exceeds 2h or RPO exceeds 1h, do not proceed to production rollout. Iterate on RE01 until drill passes.

Commit as `ops(display-data): backup restoration drill executed`

```

---

# PART 12–14: PHASE 2 — CONDENSED

**Timing:** Week 14–22 for Phase 2.

These prompts follow the same templates as Phase 1. When you reach Phase 2, ask me to expand any of these to full prompts, or use them as-is with the kickoff meta-prompt pointing Claude Code at the relevant spec section.

---

## PART 12: Phase 2 Admin Console Screens

Execute each using template:

```

Build [SCR-ID] per spec §[SCR-ID]. Dependencies: [list from spec]. Use Proposal Inbox widget where applicable. Write acceptance tests for every criterion. Commit as `feat([SCR-ID]): [name]`.

```

- **P12.1** SCR-03 Industry Vertical Builder (Sevyn8 internal — Super Admin only)
- **P12.2** SCR-11 Entity Resolution Console — consumes Proposal Inbox
- **P12.3** SCR-12 Decision Pipeline Builder (DAG editor) — this is where agents get authored visually
- **P12.4** SCR-13 Model Performance & Fairness Monitor
- **P12.5** SCR-14 Feature Store Browser
- **P12.6** SCR-15 Edge Device Manager
- **P12.7** SCR-17 Integration & Action Hub Console (full channels: WhatsApp, SMS, dialer)
- **P12.8** SCR-18 Developer Portal (API keys, webhooks, SDKs, sandbox)
- **P12.9** SCR-21 Billing, Usage & FinOps
- **P12.10** SCR-22 Compliance Operations
- **P12.11** SCR-23 DSAR Console
- **P12.12** SCR-24 Platform Ops Dashboard (full capability — Sevyn8 internal)

---

## PART 13: Phase 2 Analytical Screens

Execute each using template:

```

Build [CX-ID] per spec §[CX-ID]. Dependencies: [from spec]. Commit as `feat([CX-ID]): [name]`.

```

- **P13.1** CX-03 Customer 360
- **P13.2** CX-05 Ask Cortex (NL query powered by A05)
- **P13.3** CX-06 Customer Segments
- **P13.4** CX-07 Inventory Intelligence
- **P13.5** CX-08 Product Analytics
- **P13.6** CX-09 Loyalty Analytics
- **P13.7** CX-10 Campaign Performance & Omnichannel Journeys

---

## PART 14: Phase 2+ Backend Modules

Execute each using the cross-cutting template from P5.x:

**ML Platform:**
- A01 Feature Store
- A02 Algorithm Registry
- A03 Decision Orchestration (upgrade from P10.1 runtime to full capability)
- A04 Model Lifecycle Manager
- A07 Explainability & Audit Service

**Embeddings:**
- E01 Embedding Pipeline
- E02 Semantic Search & Discovery

**Multi-modal Ingestion:**
- G03 Document Understanding Pipeline
- G04 Video Processing Pipeline (full — replace the stub used in Phase 1)
- G05 Audio Processing Pipeline
- G06 IoT / Sensor Stream Pipeline

**Cross-Modal & Feedback:**
- S02 Cross-Modal Correlation Engine
- FB01 Human-in-the-Loop Framework
- FB02 Decision-Outcome Linkage Engine
- FB03 Decision Intelligence & Observability

**Privacy (remaining):**
- PR02 Data Principal Portal & DSAR Pipeline (full implementation)
- PR04 DPIA Workflow Engine

**Edge:**
- ED01 Edge-Cloud Orchestrator
- ED02 Edge Data Buffer & Sync
- ED03 Federated Learning Engine

**Advanced:**
- A08 Simulation & What-If Engine
- DX01 SDK & Extensibility Platform

**Resilience / Testing:**
- RE01 Disaster Recovery & Business Continuity
- T01 Platform Testing Framework (hardening beyond baseline)

---

# PART 15: TESTING, DEPLOYMENT, PRODUCTION

---

## P15.1: Unit test coverage baseline

```

Audit unit test coverage across all modules. Enforce:

- Every public function has a unit test
- Every acceptance criterion from the spec has at least one corresponding test
- Every bug fix adds a regression test
- Coverage threshold in CI: 80% line, 70% branch

Tooling: vitest (packages/apps) + Go/Python equivalents if any service uses them.

Produce a coverage report at /docs/progress/coverage-[YYYY-MM-DD].md listing every module's current coverage with gaps.

Commit as `test(platform): coverage baseline + gap report`.

```

---

## P15.2: T01 Platform Testing Framework (expanded in v2)

**Spec reference:** §T01 in full
**Dependencies:** P0.1, P0.5
**Output:** Full T01 testing framework (supersedes the narrower integration framework)

```

Implement T01 Platform Testing Framework per §T01. This expands the earlier integration-only framework from v1 into the broader testing platform the spec calls for.

Scope:

1. Synthetic data generators:
   - Per-vertical realistic data generators (retail: customers, stores, products, transactions, loyalty accounts, stock levels)
   - Display Data specific: synthetic shelf images with controlled compliance characteristics (known OOS count, known misplaced SKUs) for deterministic agent testing
   - Scale controls: generate N customers / M transactions / time window

2. Ephemeral tenant framework:
   - Spin up an isolated tenant for a test in <30s
   - Full lifecycle: provision → run test → teardown
   - Can run in parallel (test isolation guaranteed by F01)

3. Integration test harness:
   - Cross-module scenarios: ingestion → mapping → quality → agent → action
   - Clock freeze for determinism
   - Pub/Sub emulator + fake GCS + real Postgres

4. Chaos engineering harness:
   - Network partition simulation
   - Dependency failure injection (Cloud SQL unreachable, Pub/Sub delayed, KMS unavailable)
   - Load spikes
   - Can be run ad-hoc or scheduled in staging

5. Performance benchmark suite:
   - Per-screen benchmarks (SCR-01 p95 <1.5s, SCR-08 with 50 sources <2s, CX-DD-01 p95 <2s)
   - Per-module throughput benchmarks (G02 10K records/sec, I01 10K signals in <5s, A03 pipeline latency)
   - Runs nightly in staging; regressions alert

6. Contract testing:
   - Consumer-driven contracts between services
   - D03 data contract validation in CI

7. Acceptance test framework:
   - Spec-driven: every FR-NNN gets a test ID tracked in /docs/progress/acceptance.md
   - Report: coverage per module against spec acceptance criteria

Acceptance:

- `make test:integration` spins ephemeral tenant, runs 50+ scenarios, tears down in <10 min
- `make test:chaos` injects a failure, asserts recovery
- `make test:benchmarks` produces a report comparing current to baseline
- Commit as `feat(T01): platform testing framework`

```

---

## P15.3: E2E test automation

```

Build E2E test suite at /apps/admin-console/e2e/ and /apps/analytical/e2e/ using Playwright.

Critical paths covered:

- W01 tenant onboarding end-to-end
- SCR-08 adding a data source and verifying ingestion
- SCR-09 creating a mapping with agent proposal
- CX-01 loading with real data
- CX-DD-01 agent finding appearing after shelf image upload

E2E runs on every PR, against a fresh ephemeral tenant.

Commit as `test(e2e): critical-path playwright suite`.

```

---

## P15.4: Frontend quality gates (NEW in v2)

**Spec reference:** Cross-cutting (CLAUDE.md, SCR-04-FR-003)
**Dependencies:** P6.1, P6.2, widget library complete
**Output:** Unit + visual + a11y + perf gates

```

Establish frontend quality gates beyond the E2E Playwright suite.

Add to /apps/admin-console and /apps/analytical:

1. Unit tests for interactive components (Vitest + React Testing Library)
   - Every widget has unit tests for state transitions, event emission
   - Every screen has unit tests for key interactions

2. Visual regression (Chromatic or Percy)
   - Storybook stories for every widget captured as baseline (from P6.2 convention)
   - PR against main diffs against baseline; visual changes require explicit approval

3. Accessibility (axe-core + eslint-plugin-jsx-a11y)
   - Every component passes axe-core with zero WCAG 2.1 AA violations
   - Keyboard navigation reaches every interactive element in logical order
   - Focus indicators visible; focus returns correctly on modal close
   - Screen reader testing (NVDA on Windows or VoiceOver on Mac) renders headings, landmarks, labels correctly

4. Performance (Lighthouse CI)
   - Budget: LCP < 2.5s, TBT < 300ms, CLS < 0.1
   - Runs on every PR against admin-console and analytical
   - Regression fails CI

5. Bundle analysis
   - Per-route bundle size tracked
   - Alert if a route's JS > 300KB gzipped

Acceptance:

- All gates green on Phase 1 screens
- PR that breaks any gate is blocked from merge
- Commit as `feat(fe-quality): unit + visual + a11y + perf gates`

```

---

## P15.5: Load testing baseline

```

Build load test harness at /scripts/load-test/ using k6.

Scenarios:

- 1000 concurrent users, 10K events/min ingestion, 1 hour sustained
- Burst: 10K concurrent, 100K events/min, 5 minutes
- Failover: kill a replica during load; verify <30s recovery

Document target SLOs (from spec acceptance criteria) vs measured. Report at /docs/progress/load-test-[YYYY-MM-DD].md.

Commit as `test(load): baseline load tests + SLO report`.

```

---

## P15.6: Staging deployment runbook

```

Author staging deployment runbook at /docs/runbooks/staging-deploy.md covering:

- Pre-deploy checks (tests green, migrations validated, feature flags review)
- Deploy command
- Post-deploy smoke tests
- Rollback procedure
- Incident escalation paths

Commit as `docs(runbooks): staging deploy runbook`.

```

---

## P15.7: Production deployment runbook — Display Data pilot

```

Author production deployment runbook at /docs/runbooks/production-deploy-display-data.md covering the Display Data Phase 1 production rollout specifically:

- Pre-flight: staging E2E validation (P11.4) must be GREEN
- Sevyn8 CSM coordination with Display Data side
- DNS cutover plan for custom domain
- Rollback plan if anything fails
- First-48-hours heightened monitoring plan
- Success criteria for declaring production-stable

Involve: Seema (approve), engineering lead (execute), CSM (coordinate with client), DPO (compliance sign-off).

Commit as `docs(runbooks): display-data production deploy plan`.

```

---

## P15.8: Incident response runbook

```

Author incident response runbook at /docs/runbooks/incident-response.md.

Levels: P1 (production down), P2 (major feature broken), P3 (minor feature broken), P4 (bug, no user impact).

For each: detection path, escalation timeline, communication plan, post-mortem requirement.

Coordinate with RE01 Disaster Recovery (still to be built).

Commit as `docs(runbooks): incident response`.

```

---

# APPENDIX A: PROMPT TEMPLATES

For any module or screen not covered above, use one of these templates.

## A.1: Template for a new backend module

```

Implement [MODULE_ID] [MODULE_NAME] per /docs/spec/cortex_v2.docx section [SPEC_SECTION].

Read the spec section fully before coding. Verify dependencies listed in the spec are implemented — check /docs/progress/status.md.

Implement every FR-NNN requirement. Integrate with:

- F01 tenant context
- AC01 authorization
- /packages/observability
- Relevant upstream / downstream modules per spec

Write tests for every acceptance criterion.

Expose API surface internally via tRPC and externally via O01.

Update /docs/progress/status.md. Commit as `feat([MODULE_ID]): [short description]`.

```

## A.2: Template for a new admin console screen

```

Build [SCR-ID] per /docs/spec/cortex_v2.docx section [SCR-ID].

Read the spec in full. Verify dependencies implemented.

Consume widgets from /packages/widgets. For agent-proposal surfaces, use the Proposal Inbox widget.

Register in Screen Registry (F04).

Write E2E test (Playwright) exercising every acceptance criterion.

Commit as `feat([SCR-ID]): [name]`.

```

## A.3: Template for a new analytical screen

```

Build [CX-ID] per /docs/spec/cortex_v2.docx section [CX-ID].

Consume Gold-layer KPIs from D01. Register via IC01 vertical package if vertical-specific.

Layout per spec. Interactions per spec.

Commit as `feat([CX-ID]): [name]`.

```

## A.4: Template for a new widget

```

Build [WIDGET] per UX01-FR-010 requirements and /packages/widgets conventions.

Respect theme, locale, RBAC masking, data quality badge. Handle loading/error/empty. Emit events.

Add Storybook/Ladle coverage. Add visual regression test.

Commit as `feat(widgets/[category]): [widget name]`.

```

## A.5: Template for a new agent pipeline

```

Author a new decision pipeline under /agents/[agent-name]/pipelines/[pipeline-name].yaml.

Nodes per A03 type catalog. Inputs / outputs typed. LLM prompts stored separately and version-controlled.

Add pipeline-specific test fixtures to /agents/[agent-name]/test-fixtures/. Accuracy benchmark baseline set.

Commit as `feat(agents/[agent]): [pipeline name] pipeline`.

```

## A.6: Template for debugging a specific module

```

Something is wrong with [MODULE]. Before fixing anything:

1. Read the last N commits touching the module
2. Run the module's tests. Paste the failing output.
3. Read the relevant spec section.
4. Identify the drift: spec vs implementation
5. Propose minimal fix
6. Add regression test
7. Apply fix

Commit as `fix([MODULE]): [brief description]`.

```

---

# APPENDIX B: REPO STRUCTURE REFERENCE

```

cortex/
├── apps/
│ ├── admin-console/ # Next.js — SCR-01 through SCR-24, W01
│ ├── analytical/ # Next.js — CX-01 through CX-DD-01
│ ├── api-gateway/ # Node + Fastify — O01
│ ├── mcp-cortex-core/ # MCP server
│ ├── mcp-edge/ # MCP server
│ ├── mcp-admin-ops/ # MCP server
│ ├── agents/
│ │ ├── planogram/
│ │ ├── pac/
│ │ ├── promotion/
│ │ └── perishable/
│ └── dis-worker/ # Data Ingestion Service workers
├── packages/
│ ├── widgets/ # UX01 Widget Library
│ ├── design-system/ # Theme, tokens, typography
│ ├── ui-shell/ # AppShell, navigation, tenant switcher
│ ├── api-client/ # Generated tRPC/OpenAPI clients
│ ├── canonical-schema/ # D01 types + Zod
│ ├── auth/ # AC01 client helpers
│ ├── tenant-context/ # F01 context provider
│ ├── screen-registry/ # UX01 screen registry consumer
│ ├── observability/ # Logging/metrics/tracing
│ ├── secrets/ # Secret Manager + KMS
│ ├── temporal-query/ # F03 temporal query library
│ └── cortex-sdk/ # Public SDK (DX01)
├── services/
│ ├── foundation/ # F01–F05
│ ├── data-platform/ # D01–D06
│ ├── identity/ # I01–I03
│ ├── ingestion/ # G01–G06
│ ├── access/ # AC01–AC04
│ ├── streaming/ # S01
│ ├── industry/ # IC01–IC02
│ ├── ai/ # A01–A08, E01–E02
│ ├── orchestration/ # O01–O04
│ ├── observability/ # OB01–OB03
│ ├── privacy/ # PR01–PR06
│ ├── edge/ # ED01–ED03
│ ├── feedback/ # FB01–FB03
│ ├── resilience/ # RE01
│ └── testing/ # T01
├── infra/
│ ├── terraform/
│ ├── k8s/
│ ├── dev/ # docker-compose for local
│ └── ci/
├── docs/
│ ├── spec/ # cortex_v2.docx
│ ├── skills/ # sevyn8-workflow SKILL.md
│ ├── architecture/decisions/ # ADRs
│ ├── progress/
│ │ ├── status.md
│ │ └── handoff-YYYY-MM-DD.md
│ ├── runbooks/
│ └── onboarding.md
├── scripts/
├── .github/workflows/
├── pnpm-workspace.yaml
├── turbo.json (or nx.json)
├── tsconfig.base.json
├── Makefile
├── README.md
├── CLAUDE.md
├── CONTRIBUTING.md
└── LICENSE

````

---

# APPENDIX C: PROGRESS TRACKER TEMPLATE (v2)

Create `/docs/progress/status.md` at build start. Includes all 100+ v2 Phase 1 prompts:

```markdown
# Cortex Build Progress

Last updated: [YYYY-MM-DD]

## Pre-flight (before any Claude Code session)
- [ ] Claude Code installed + logged in
- [ ] Pro or Max plan active
- [ ] GitHub org + repo set up
- [ ] GCP org + billing + projects
- [ ] WorkOS account created
- [ ] Resend account created
- [ ] Anthropic API key for A05 procured
- [ ] Ithina contacts confirmed (HHT, POS, training data)
- [ ] Architectural decisions reviewed (Appendix D)
- [ ] All Pre-flight checklist items from body of prompts file ticked

## Phase 0 — Foundation
- [ ] P0.1 Initialize monorepo (with CLAUDE.md content)
- [ ] P0.2 Dev environment
- [ ] P0.3 GCP Terraform baseline
- [ ] P0.4 Postgres + bi-temporal helpers
- [ ] P0.5 CI/CD
- [ ] P0.6 Observability baseline
- [ ] P0.7 Secret Manager + KMS
- [ ] P0.8 MCP scaffolding
- [ ] P0.9 Super Admin bootstrap (NEW)
- [ ] P0.10 Audit event emission convention (NEW)

## Phase 1 — Display Data Go-Live

### Foundation Layer (F01–F05)
- [ ] P1.1 F01 Multi-Tenancy
- [ ] P1.2 F02 Tenant Lifecycle
- [ ] P1.3 F03 Temporal Data Engine
- [ ] P1.4 F04 Configuration Plane
- [ ] P1.5 F05 Schema Evolution
- [ ] P1.6 Feature Flags service (NEW)

### Access Control (AC01–AC04)
- [ ] P2.1 AC01 ABAC + RBAC
- [ ] P2.2 AC02 Hierarchy
- [ ] P2.3 AC03 Consent
- [ ] P2.4 AC04 Compliance Policy

### Data Platform (D01–D06)
- [ ] P3.1 D01 Canonical Model
- [ ] P3.2 D02 Mapping Engine
- [ ] P3.3 D03 Data Contracts
- [ ] P3.4 D04 Data Quality
- [ ] P3.5 D05 Lineage
- [ ] P3.6 D06 Polyglot Storage

### Identity & Ingestion (I01, I02, G01, G02)
- [ ] P4.1 I01 SIR
- [ ] P4.2 I02 Knowledge Graph (Phase 1 cut)
- [ ] ~~P4.3 I03 Conflict Resolution~~ (deferred to Phase 2 per ADR-SCOPE-001)
- [ ] P4.4 G01 Ingestion Gateway
- [ ] P4.5 G02 Structured Pipeline

### Cross-Cutting Platform (expanded in v2)
- [ ] P5.1 S01 Streaming
- [ ] P5.2 IC01 Industry Ontology (engine)
- [ ] P5.3 IC02 Localization
- [ ] P5.4 A05 LLM Gateway
- [ ] P5.5 A06 Rule Engine
- [ ] P5.6 O01 API Gateway
- [ ] P5.7 O02 Alert Engine
- [ ] P5.8 O04 Action Hub (core)
- [ ] P5.9 OB01 Observability
- [ ] P5.10 OB02 FinOps (stub)
- [ ] P5.11 OB03 Metering (stub)
- [ ] P5.12 PR01 Purpose Registry
- [ ] P5.13 PR03 Breach Detection
- [ ] P5.14 PR05 Sub-Processor Registry
- [ ] P5.15 PR06 Retention Clock
- [ ] P5.16 RE01 Disaster Recovery (NEW)
- [ ] P5.17 IC01 Retail Vertical Package content (NEW)
- [ ] P5.18 Display Data Extension Package (NEW)
- [ ] P5.19 Standard Error Response Format (NEW)
- [ ] P5.20 Transactional Email Templates (NEW)

### Frontend Foundation (UX01 shell)
- [ ] P6.1 Next.js apps + shell
- [ ] P6.2 Design system + Storybook (v2 amended)
- [ ] P6.3 Screen Registry consumer
- [ ] P6.4 Layout Engine
- [ ] P6.5 Widget library scaffolding

### Widget Library — Phase 1
- [ ] P7.1 KPI cards
- [ ] P7.2 Charts
- [ ] P7.3 Data table
- [ ] P7.4 Filters
- [ ] P7.5 Entity cards
- [ ] P7.6 Alerts feed
- [ ] P7.7 Conversational
- [ ] P7.8 Proposal Inbox (+ design spike + ADR)
- [ ] P7.9 Leaderboard

### Admin Console — Phase 1
- [ ] P8.1 SCR-01 Tenant Overview
- [ ] P8.2 SCR-02 Users, Teams, Workspaces
- [ ] P8.3 SCR-04 Tenant Config & Theme
- [ ] P8.4 SCR-05 Hierarchy Manager
- [ ] P8.5 SCR-06 Role & Permission Manager
- [ ] P8.6 SCR-07 Canonical Schema Browser
- [ ] P8.7 SCR-08 Data Source Wizard
- [ ] P8.8 SCR-09 Mapping Studio
- [ ] P8.9 SCR-10 Data Quality Console
- [ ] P8.10 SCR-16 Consent Manager (Phase 1 cut)
- [ ] P8.11 SCR-19 Alert Rules
- [ ] P8.12 SCR-20 Audit Log
- [ ] P8.13 SCR-24 Platform Ops (min cut) (NEW)
- [ ] P8.14 W01 Onboarding Wizard

### Analytical Screens — Phase 1
- [ ] P9.1 CX-01 Executive Dashboard
- [ ] P9.2 CX-02 Store Performance
- [ ] P9.3 CX-04 Alert Centre
- [ ] P9.4 CX-DD-01 Shelf & Planogram Intelligence

### Ithina Agents
- [ ] P10.1 Agent runtime foundation
- [ ] P10.1a Model Registry Light (NEW)
- [ ] P10.2 Planogram Agent
- [ ] P10.3 PAC Agent
- [ ] P10.4 Promotion Agent
- [ ] P10.5 Perishable Agent
- [ ] P10.6 Agent testing harness
- [ ] P10.7 CSV Ingestion Agent integration (NEW)

### Display Data Go-Live
- [ ] P11.1 Staging tenant provisioned (+ seeds from v2)
- [ ] P11.2 Shelf imagery ingestion live
- [ ] P11.3 POS ingestion live
- [ ] P11.4 E2E validation GREEN
- [ ] P11.5 Backup restoration drill (NEW)

## Phase 2+ (see body of this document for prompts)

## Testing & Production
- [ ] P15.1 Unit coverage baseline
- [ ] P15.2 T01 Platform Testing Framework (expanded in v2)
- [ ] P15.3 E2E automation
- [ ] P15.4 Frontend quality gates (NEW)
- [ ] P15.5 Load testing
- [ ] P15.6 Staging deploy runbook
- [ ] P15.7 Production deploy runbook
- [ ] P15.8 Incident response runbook

## Release criteria for Display Data production

Before flipping the DNS to production, confirm:
- [ ] All Phase 1 prompts above checked ✓
- [ ] P11.4 E2E validation GREEN
- [ ] P11.5 Backup drill GREEN (RTO <2h, RPO <1h)
- [ ] Penetration test complete
- [ ] DPA signed
- [ ] Sub-processor list published
- [ ] DPO compliance sign-off
- [ ] First-48-hour monitoring plan staffed
````

---

# APPENDIX D: DECISIONS LOG (BAKED INTO V2)

Every decision below is baked into the v2 prompts. Override only with ADR capturing rationale.

### Stack decisions

| ID            | Decision        | Choice                       | Baked into prompt                                                                                                                                                 |
| ------------- | --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-STACK-001 | Auth provider   | WorkOS                       | P2.1, CLAUDE.md                                                                                                                                                   |
| ADR-STACK-002 | Monorepo tool   | Turborepo                    | P0.1, CLAUDE.md                                                                                                                                                   |
| ADR-STACK-003 | ORM             | Drizzle                      | P0.4, CLAUDE.md                                                                                                                                                   |
| ADR-STACK-004 | CSS framework   | Tailwind 4                   | P6.2                                                                                                                                                              |
| ADR-STACK-005 | Migration tool  | drizzle-kit                  | P0.4                                                                                                                                                              |
| ADR-STACK-006 | i18n library    | next-intl                    | P5.3                                                                                                                                                              |
| ADR-STACK-007 | Email provider  | Resend                       | P5.20 — SendGrid killed its permanent free tier mid-2025 (60-day trial → $19.95/mo min); Resend has permanent 3K/mo free tier, better DX, React Email integration |
| ADR-STACK-008 | Node runtime    | 22 LTS                       | P0.1                                                                                                                                                              |
| ADR-STACK-009 | Package manager | pnpm                         | P0.1                                                                                                                                                              |
| ADR-STACK-010 | RSC strategy    | Server shell, Client screens | P6.1                                                                                                                                                              |

### Scope decisions (Phase 1 boundaries)

| ID            | Decision                             | Choice                                                     | Rationale                                                                                                                                                       |
| ------------- | ------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-SCOPE-001 | I03 Multi-Source Conflict Resolution | Deferred to Phase 2                                        | Display Data Phase 1 focuses on store/product/transaction; Body Shop drives I03 demand                                                                          |
| ADR-SCOPE-002 | I02 Knowledge Graph                  | Phase 1 cut via Postgres recursive CTEs                    | Abstraction interface ready for Phase 3 graph DB migration                                                                                                      |
| ADR-SCOPE-003 | ED01 Edge-Cloud Orchestrator         | Deferred to Phase 2                                        | No edge inference devices in Display Data Phase 1                                                                                                               |
| ADR-SCOPE-004 | Mobile UX                            | Tablet (768px+) Phase 1; phone Phase 2                     | Admin users on desktop/tablet primarily                                                                                                                         |
| ADR-SCOPE-005 | Workspace isolation                  | Strict per-workspace; Tenant Admin rollup for billing only | Display Data multi-workspace requirement                                                                                                                        |
| ADR-SCOPE-006 | Dashboard Builder UI                 | Parked to Phase 3                                          | Sevyn8 authors dashboards in Phase 1-2                                                                                                                          |
| ADR-SCOPE-007 | SCR-24 Platform Ops                  | Minimal cut (provisioning wizard) Phase 1                  | CSM needs provisioning UI for Display Data rollout                                                                                                              |
| ADR-SCOPE-008 | O02 Alert Engine                     | Moved from Phase 2 → Phase 1                               | SCR-19 is Phase 1 and requires O02                                                                                                                              |
| ADR-SCOPE-009 | ROOS boundary                        | External to Cortex                                         | Ithina operates ROOS; Cortex consumes `dis.golden.roos` via G01 Kafka connector; Cortex builds no POS-specific listeners; Ithina's existing agents stay on ROOS |

### Infrastructure decisions

| ID            | Decision  | Choice                                       | Rationale                                                                                                                                                                                                                                                             |
| ------------- | --------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-INFRA-001 | Event bus | Pub/Sub internal, Kafka at integration edges | Operational simplicity for small team at Phase 1; GCP-native integrations (Dataflow, Eventarc) work out of the box; external Kafka via G01 covers ROOS + any future Kafka-speaking partner; `@cortex/event-bus` package abstracts internal bus for future optionality |

### Non-functional targets

| ID          | Decision                        | Value                              |
| ----------- | ------------------------------- | ---------------------------------- |
| ADR-NFR-001 | Enterprise tier RPO             | 1 hour                             |
| ADR-NFR-002 | Enterprise tier RTO             | 2 hours                            |
| ADR-NFR-003 | Authz decision latency (cached) | p99 < 5ms                          |
| ADR-NFR-004 | Alert rule propagation          | < 30s                              |
| ADR-NFR-005 | Unit test coverage              | 80% line / 70% branch              |
| ADR-NFR-006 | Accessibility standard          | WCAG 2.1 AA                        |
| ADR-NFR-007 | Performance budget              | LCP < 2.5s, TBT < 300ms, CLS < 0.1 |
| ADR-NFR-008 | Per-route bundle size           | < 300KB gzipped                    |

---

# APPENDIX E: SURVIVAL NOTES — WHAT WILL TRIP YOU UP

Even with all the above addressed, expect these to surface during build. Awareness won't prevent them but will shorten recovery.

### Technical surprises

1. **Claude Code context window limits on big prompts.** P8.7 (SCR-08 full operational cockpit) and P9.4 (CX-DD-01) will almost certainly exceed a single session. Plan to sub-prompt these: wizard flow, record inspector, DLQ view, live tail, schema drift as separate sessions. Don't pre-divide; wait until you hit the wall, then split.

2. **Spec drift during build.** The v2 spec will prove wrong in small ways during implementation. Enforce the "update spec OR update code, never leave drift uncommented" rule. ADRs for significant deviations.

3. **Ithina readiness.** The HHT app, POS file format, training data may not all be ready when you reach P11.2. Fallback plan: synthetic data from P10.6 harness carries Phase 1 to "technically validated"; real data integration gated on Ithina's timelines.

4. **WorkOS integration time.** Enterprise SSO setup has its own multi-week onboarding. Start this out-of-band in Week 1 so it's ready when you reach P2.1.

5. **Model training time for YOLO fine-tune.** Not code work, but hours of compute and days of iteration. If Ithina's annotated data isn't immediately available, agents run with baseline accuracy until retraining catches up. Flag to stakeholders.

6. **DPDP compliance artifacts timing.** DPA, sub-processor list, data residency evidence need to be ready BEFORE first real customer data lands. Don't let this be an afterthought at week 14.

7. **Performance at real data scale.** Every screen is benchmarked against simulated scale. Real Display Data volume (100+ stores × 10K SKUs × daily POS × 3x daily shelf captures) will have edge cases. Reserve a buffer week post-P11.4 for real-data tuning.

8. **Workspace switcher UX subtleties.** Multi-workspace is baked into Phase 1 (F01, W01, SCR-02). The UX of switching between Ithina downstream clients has edge cases (in-flight requests, cached state, URL parameters). Budget iteration.

9. **Agent false positives.** CV models will produce findings that are wrong. The Proposal Inbox widget pattern helps, but the steward workflow for dismissing bad findings needs tuning over weeks of real use. Treat accuracy targets as a floor, not a ceiling.

10. **Cost surprises.** Anthropic API (A05), Cloud SQL, BigQuery egress, GCS lifecycle — costs add up fast in a multi-tenant platform. OB02 is stubbed; keep manual eye on monthly spend during Phase 1 so surprises are caught early.

11. **Claude Code credential management.** Some prompts require real GCP credentials (Terraform apply, Cloud SQL migrations). Don't hand Claude Code production credentials. Keep production access manual; Claude Code operates on dev and staging.

12. **Dependency version drift.** Long-running project, many packages, frequent updates. Renovate or Dependabot configured early in P0.5 saves months of catching-up later.

### Process surprises

13. **Prompt iteration is expected.** First few sessions will surface issues no review could anticipate. Treat P0.1 through P0.4 as dress rehearsal — if Claude Code produces sloppy output on basic scaffolding, iterate on CLAUDE.md and the prompt text before committing to harder work.

14. **Context loss across sessions.** M1 re-anchors but doesn't replace reading the actual code. Claude Code in a new session with only M1 will sometimes miss conventions established in earlier sessions. Keep CLAUDE.md rich and up-to-date.

15. **Human review bandwidth.** If you're solo, M4 (code review meta-prompt) is the only review. Allocate real time to it — don't skip between every 3rd session.

---

# APPENDIX F: POST-PHASE-1 ACTIONS

After Display Data goes live, within the first 30 days:

1. **Prompts retrospective.** Which prompts were well-scoped? Which were too big? Which sent Claude Code down wrong paths? Update this document with lessons before Phase 2 starts. This document is the foundation — iterating it is high-leverage.

2. **Spec v3 reconciliation.** Everything built differently from spec gets captured in an updated spec. Before Phase 2, the spec is re-rendered as v3 with every Phase 1 deviation incorporated. Keeps the spec as source of truth going forward rather than letting code become the truth.

3. **Ithina retrospective.** What worked in the coordination? What didn't? This informs how future vertical partner launches are scoped.

4. **Agent accuracy baseline refresh.** The synthetic benchmarks from P10.6 are calibrated for Phase 1 launch. After 30 days of real production data, re-baseline against actual Display Data store data.

5. **Cost review.** First month's GCP and Anthropic bill. Adjust forecasts, tighten lifecycle policies, identify optimization opportunities before Phase 2 scale-up.

---

# FINAL NOTES

**Ordering discipline:** Phase 1 has ~60 prompts (P0.1 through P11.4). Some can parallel (e.g., frontend P6–P7 with backend P5.x), but the dependency spine must be respected. Do not skip P0 (infra) to get to screens faster — you will waste weeks later.

**Spec fidelity:** Every prompt says "read the spec." Mean it. Claude Code should quote the specific FR-NNN requirements it's implementing before writing code. The spec is authoritative.

**Agent IP:** The four Ithina agents (P10.2–P10.5) are Display Data's differentiator. Build them well. Invest in the test harness (P10.6). Every agent finding Display Data's clients see either makes them retention customers or churns them.

**Custom domain + multi-workspace:** These were committed to in the v2 spec for Display Data. If anything in the build drifts away from these commitments, stop and escalate — don't re-interpret the commitment.

**Proposal Inbox widget (P7.8):** Build this ONCE, well, before SCR-09. Every consuming screen inherits its UX. If it's wrong, six screens are wrong. Worth a full design spike.

**Production rollout:** No production deployment until P11.4 staging validation is GREEN. This is non-negotiable for a multi-tenant platform handling DPDP-regulated data.

— End of document —

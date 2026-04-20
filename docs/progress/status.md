# Cortex Build Progress

Last updated: April 2026 (initial scaffold)

## Pre-flight

- [x] Claude Code installed + logged in
- [x] GitHub org + repo set up (rahul-1974/Cortex)
- [x] Repo cloned into WSL (~/projects/Cortex)
- [x] v2.1 spec committed at docs/spec/cortex_v2.docx
- [x] v3 build prompts committed at docs/build-prompts/cortex_build_prompts_v3.md
- [x] ADR-INFRA-001 + ADR-SCOPE-009 committed
- [x] Sevyn8 workflow SKILL.md committed
- [x] Integration stubs committed (roos-interface.md, roos-agent-boundaries.md)
- [ ] GCP org + billing + projects set up
- [x] WorkOS account created
- [x] Anthropic API key procured
- [x] Resend account created
- [ ] Ithina contacts confirmed (HHT, POS, training data)
- [ ] Architectural decisions reviewed (Appendix D of build prompts)
- [ ] DPA between Sevyn8 and Display Data drafted

## Phase 0 — Foundation

- [x] P0.1 Initialize monorepo
- [ ] P0.2 Dev environment
- [ ] P0.3 GCP Terraform baseline
- [ ] P0.4 Postgres + bi-temporal helpers
- [ ] P0.5 CI/CD
- [ ] P0.6 Observability baseline
- [ ] P0.7 Secret Manager + KMS
- [ ] P0.8 MCP scaffolding
- [ ] P0.9 Super Admin bootstrap
- [ ] P0.10 Audit event emission convention

## Phase 1 — Display Data Go-Live

### Foundation Layer

- [ ] P1.1 F01 Multi-Tenancy
- [ ] P1.2 F02 Tenant Lifecycle
- [ ] P1.3 F03 Temporal Data Engine
- [ ] P1.4 F04 Configuration Plane
- [ ] P1.5 F05 Schema Evolution
- [ ] P1.6 Feature Flags

### Access Control

- [ ] P2.1 AC01 ABAC + RBAC
- [ ] P2.2 AC02 Hierarchy
- [ ] P2.3 AC03 Consent
- [ ] P2.4 AC04 Compliance Policy

### Data Platform

- [ ] P3.1 D01 Canonical Model
- [ ] P3.2 D02 Mapping Engine
- [ ] P3.3 D03 Data Contracts
- [ ] P3.4 D04 Data Quality
- [ ] P3.5 D05 Lineage
- [ ] P3.6 D06 Polyglot Storage

### Identity & Ingestion

- [ ] P4.1 I01 SIR
- [ ] P4.2 I02 Knowledge Graph
- [ ] ~~P4.3 I03 Conflict Resolution~~ (deferred to Phase 2)
- [ ] P4.4 G01 Ingestion Gateway (per ADR-INFRA-001 + ADR-SCOPE-009)
- [ ] P4.5 G02 Structured Pipeline

### Cross-Cutting Platform

- [ ] P5.1 S01 Streaming
- [ ] P5.2 IC01 Industry Ontology
- [ ] P5.3 IC02 Localization
- [ ] P5.4 A05 LLM Gateway
- [ ] P5.5 A06 Rule Engine
- [ ] P5.6 O01 API Gateway
- [ ] P5.7 O02 Alert Engine
- [ ] P5.8 O04 Action Hub
- [ ] P5.9 OB01 Observability
- [ ] P5.10 OB02 FinOps (stub)
- [ ] P5.11 OB03 Metering (stub)
- [ ] P5.12 PR01 Purpose Registry
- [ ] P5.13 PR03 Breach Detection
- [ ] P5.14 PR05 Sub-Processor Registry
- [ ] P5.15 PR06 Retention Clock
- [ ] P5.16 RE01 Disaster Recovery
- [ ] P5.17 Retail Vertical Package
- [ ] P5.18 Display Data Extension Package
- [ ] P5.19 Standard Error Format
- [ ] P5.20 Email Templates

### Frontend Foundation

- [ ] P6.1 Next.js apps + shell
- [ ] P6.2 Design system + Storybook
- [ ] P6.3 Screen Registry consumer
- [ ] P6.4 Layout Engine
- [ ] P6.5 Widget library scaffolding

### Widget Library

- [ ] P7.1 KPI cards
- [ ] P7.2 Charts
- [ ] P7.3 Data table
- [ ] P7.4 Filters
- [ ] P7.5 Entity cards
- [ ] P7.6 Alerts feed
- [ ] P7.7 Conversational
- [ ] P7.8 Proposal Inbox (+ design spike)
- [ ] P7.9 Leaderboard

### Admin Console

- [ ] P8.1 SCR-01 Tenant Overview
- [ ] P8.2 SCR-02 Users
- [ ] P8.3 SCR-04 Tenant Config
- [ ] P8.4 SCR-05 Hierarchy
- [ ] P8.5 SCR-06 Role & Permission
- [ ] P8.6 SCR-07 Schema Browser
- [ ] P8.7 SCR-08 Data Source Wizard
- [ ] P8.8 SCR-09 Mapping Studio
- [ ] P8.9 SCR-10 Data Quality
- [ ] P8.10 SCR-16 Consent Manager
- [ ] P8.11 SCR-19 Alert Rules
- [ ] P8.12 SCR-20 Audit Log
- [ ] P8.13 SCR-24 Platform Ops (min)
- [ ] P8.14 W01 Onboarding Wizard

### Analytical Screens

- [ ] P9.1 CX-01 Executive Dashboard
- [ ] P9.2 CX-02 Store Performance
- [ ] P9.3 CX-04 Alert Centre
- [ ] P9.4 CX-DD-01 Shelf & Planogram Intelligence

### Ithina Agents

- [ ] P10.1 Agent runtime
- [ ] P10.1a Model Registry Light
- [ ] P10.2 Planogram Agent
- [ ] P10.3 PAC Agent
- [ ] P10.4 Promotion Agent
- [ ] P10.5 Perishable Agent
- [ ] P10.6 Testing harness
- [ ] P10.7 CSV Ingestion Agent

### Display Data Go-Live

- [ ] P11.1 Staging tenant provisioned
- [ ] P11.2 Shelf imagery ingestion live
- [ ] P11.3 POS ingestion live via ROOS
- [ ] P11.4 E2E validation GREEN
- [ ] P11.5 Backup restoration drill

## Testing & Production

- [ ] P15.1 Unit coverage baseline
- [ ] P15.2 T01 Testing Framework
- [ ] P15.3 E2E automation
- [ ] P15.4 Frontend quality gates
- [ ] P15.5 Load testing
- [ ] P15.6 Staging deploy runbook
- [ ] P15.7 Production deploy runbook
- [ ] P15.8 Incident response runbook

## Release criteria for Display Data production

- [ ] All Phase 1 prompts checked
- [ ] P11.4 E2E validation GREEN
- [ ] P11.5 Backup drill GREEN (RTO <2h, RPO <1h)
- [ ] Penetration test complete
- [ ] DPA signed
- [ ] Sub-processor list published
- [ ] DPO compliance sign-off
- [ ] First-48-hour monitoring plan staffed
- [ ] ROOS interface contract fully filled in

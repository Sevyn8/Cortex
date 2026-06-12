---
name: sevyn8-workflow
description: "Sevyn8 business workflow skill for Seema Prasad Avasarala, Co-Founder of Sevyn8 Private Limited. Use this skill for ANY task involving Sevyn8 work: drafting proposals, partnership documents, pitch materials, technical specifications, financial analysis, competitive research, investor communications, client-facing deliverables, internal strategy documents, or any document referencing edge AI, Cortex, HAL, DIS, Know Your Skin, VMukti, Display Data, Nash Industries, Swiss Re, Body Shop, Quest Retail, Ithina, MCP architecture, STQC compliance, or the Indian CCTV/VMS landscape. Also trigger when asked to organise files, prepare meeting briefs, compile research, draft emails to partners or investors, or produce any content where Sevyn8 context, brand voice, or strategic positioning matters. Even if the user doesn't say 'Sevyn8' explicitly — if the task involves edge AI platforms, camera intelligence, retail analytics, or reinsurance data intelligence, this skill applies."
---

# Sevyn8 Workflow Skill

## Company Identity

**Sevyn8 Private Limited** — DPIIT-recognised edge AI platform company, New Delhi.
Co-founded by Seema Prasad Avasarala.

**Positioning:** "The Android of Edge AI" — the decisioning layer for physical spaces. Hardware-agnostic (SoC-agnostic, camera-agnostic, sensor-agnostic). Runs on Jetson, Ambarella, Qualcomm QCS, Rockchip, Novatek, Hailo.

**Core platform:** HAL (Hardware Abstraction Layer) + edge AI inference stack + Cortex (cloud intelligence platform).

**What Sevyn8 is NOT:** Sevyn8 does NOT build cameras in Phase 1. Cameras are either existing (enterprise brownfield) or manufactured by OEM partners. Sevyn8 builds the Edge Hub (inference box) and the intelligence layer. Sevyn8 does NOT compete with VMS players — it sits underneath them, making their cameras intelligent.

---

## Brand Voice & Writing Style

Seema's documents share a distinctive voice. Follow these principles in all output:

### Tone

- **Confident, not boastful.** State capabilities as facts. No superlatives ("best-in-class", "world-leading"). No marketing fluff.
- **Technical depth with strategic clarity.** Every technical detail should connect to a business outcome. Never technical for its own sake.
- **Direct and lean.** Short sentences. No filler paragraphs. Every sentence earns its place.
- **Builder's voice.** Written by someone who has built the thing, not by someone describing it from outside.

### Structure

- Lead with the problem or opportunity, not with Sevyn8.
- Use comparison tables to make arguments concrete (Cloud vs Edge, Before vs After, Current vs Evolved).
- Use numbered sections with clear hierarchy.
- Proposals follow: Executive Summary → Problem/Opportunity → Solution → Architecture → Economics → Engagement Structure → Team → Next Steps.
- Internal documents are leaner — skip the formalities, get to the argument.

### Words to use

- "Intelligence layer", "decisioning", "compounding learning", "fleet orchestration"
- "Invisible Intelligence" (for in-store recognition — staff never reveals the technology)
- "Hardware-agnostic", "SoC-agnostic", "edge-native"
- "Consent-based", "privacy by architecture"
- "The Android of Edge AI" (sparingly, in positioning contexts)

### Words to avoid

- "Cutting-edge", "revolutionary", "game-changing", "disruptive"
- "Leverage", "synergy", "holistic"
- "Solution" as a standalone noun (say what the solution actually is)
- "AI-powered" as a generic modifier (be specific about which AI does what)

### Formatting

- Dark navy + accent green palette for slide decks and branded documents.
- Tables over bullet points when comparing options.
- Diagrams and architecture visuals over long prose when explaining systems.
- Keep proposals under 15 pages. Keep one-pagers to one page.

---

## Active Business Conversations

These four relationships form one value chain. Body Shop is the gate for everything else.

### 1. The Body Shop India (Quest Retail) — Demand Proof Point

- **Status:** Principally agreed POC. ₹19L, 12 weeks, 3 stores.
- **Solution:** Know Your Skin (browser PWA skin analysis via Face++) + In-store recognition (ArcFace edge matching) + Cortex intelligence.
- **Production URL:** https://know-your-skin-rho.vercel.app/
- **Key concept:** Two-touchpoint consent (general + biometric). Invisible Intelligence protocol.
- **Documents produced:** Multiple proposal iterations, React demo app, 200+ SKU product knowledge base.

### 2. Display Data (Ithina) — Channel Partner

- **Solution:** Ithina strategic intelligence platform. React Native HHT app + DIS Phase 1.
- **Architecture:** ROOS path + Direct/ScanLink path. Kafka event bus. 4 AI agents (PAC, Promotion, Planogram, Perishable).
- **Pricing:** Phase 1 at ₹15L / USD 16,870.

### 3. VMukti — Infrastructure/Distribution Partner

- **Context:** 18-year VMS company, 900+ deployments, 142K+ cameras, STQC-certified VMS.
- **Five partnership models:** Edge AI licensing, STQC chipset rescue (Ambicam), joint retail, brownfield upgrade, white-label for govt tenders.
- **Key economics:** ~51% 3-year TCO savings edge vs cloud. PoC at ₹15-25L NRE.
- **Strategic value:** Distribution, hardware validation, government credibility, first domino for CP Plus/Matrix/Prama/Sparsh.

### 4. Nash Industries — OEM Hardware Partner

- Hardware company manufacturing edge boxes. Sevyn8 provides intelligence layer.

### 5. Swiss Re (via Ensuredit brand) — Reinsurance Vertical

- **Brand:** Ensuredit Technologies Private Limited (not Sevyn8-branded).
- **Solution:** Cortex for reinsurance — bordereaux auto-mapping, SOV processing, entity resolution across cedants, accumulation monitoring, loss event response.
- **Key example:** Tokyo Tower resolved across 5 cedants in 5 formats.
- **Engagement:** 3-phase (PoC 8-12 weeks → Production Pilot → Enterprise Scale).

---

## Platform Architecture Reference

### Cortex (Cloud Intelligence Platform)

- Multi-tenant, multi-industry on GCP (Cloud SQL, BigQuery, GCS, Pub/Sub, GKE Autopilot).
- 61 modules, 17 architectural layers, 5 deployment phases, 360 functional requirements.
- PostgreSQL 15+ primary DB, bi-temporal columns on every table, row-level security.
- Pipeline: Ingest → Canonical mapping → Identity resolution → Quality scoring → Temporal store → Algorithms → Decisions → Actions → Feedback → Compounding learning.
- MCP-native architecture: 3 MCP servers (Cortex Core, Edge, Admin/Ops).
- White-label ready. DPDP & GDPR compliant.

### DIS (Data Ingestion Service)

- 10-state machine, 7-stage pipeline.
- Bronze/Silver/Gold medallion architecture.
- GCP-native: Eventarc, Cloud Run, Cloud Tasks.
- Design principle: Never silently ingest bad data, never silently reject files.
- Handles 1.5M daily events.

### Edge Hardware

- Three tiers: Nano, Pro, Cluster.
- Recommended: AGX Orin HUB + Hailo worker nodes.
- TPM 2.0, Secure Element, hardware crypto.
- ~46% BOM savings with cost-optimised path vs pure Jetson at 100-outlet scale.

---

## Financial Model Reference

- **4 verticals:** Retail (Y1), Smart Home (Y1), Logistics/Fleet (mid-Y2), Food/Cold Storage (mid-Y2).
- **3 channels:** B2B, B2B2C, B2C.
- **Revenue trajectory:** ₹13.4 Cr (Y1) → ₹86.7 Cr (Y2) → ₹387.3 Cr (Y3).
- **Gross margin:** 69.5% → 72.2% → 76.0%.
- **8-layer revenue model:** Hardware (entry) → Platform subscription per camera (retention) → AI model packs per vertical (expansion) → Services.
- **Seed raise:** ₹21 Cr in two tranches (₹14 Cr months 1-9, ₹7 Cr months 9-18).

---

## Competitive Landscape

Indian CCTV/VMS players: CP Plus, Videonetics, Matrix, VMukti, Prama, Sparsh.
Sevyn8 is "the platform underneath" — not competing but enabling.
The Android analogy: no OEM builds the OS for the industry.

Post April 1, 2026 STQC mandate: Chinese vendors (HiSilicon/Ingenic chipsets) locked out. Only ~507 certified models from ~7 brands. Supply vacuum in ₹7K-15K mid-range segment. Price floor risen 15-20%.

---

## Task Patterns

When asked to produce Sevyn8 work, follow these patterns:

### Proposals & Client Documents

1. Read this skill fully before writing.
2. Match the voice and structure described above.
3. Always include: clear problem statement, concrete economics (tables with numbers), phased engagement structure, what Sevyn8 expects from the partner.
4. Use the correct entity name and branding (Sevyn8 Private Limited for most; Ensuredit Technologies for Swiss Re/reinsurance).
5. Mark as CONFIDENTIAL where appropriate.

### Pitch Deck Content

1. Dark navy + accent green palette.
2. 9-slide structure: Why AI at Edge → Why Now → TAM/SAM/SOM → Solution → GTM Strategy → Financials → Use of Funds → Team → Ask.
3. TAM/SAM/SOM: $48.6B → $7.2B → $850M.
4. Never show Sevyn8 as a camera company. Always show as platform/intelligence layer.

### Technical Specifications

1. Use module IDs (F01, D01, I01, etc.) consistent with the master spec.
2. Include functional requirement numbering (F01-FR-001 pattern).
3. Always specify: Phase, Complexity, Dependencies, Depended On By.
4. Bi-temporal columns on every data table. RLS on every tenant-scoped table.

### Emails & Communications

1. Brief, direct, no pleasantries beyond one line.
2. Lead with what you need from the recipient or what you're delivering.
3. Close with a specific next step and timeline.

### Internal Strategy Documents

1. State the recommendation upfront.
2. Provide the reasoning, not just the conclusion.
3. Include what was considered and rejected.
4. End with specific next actions.

### File Organisation

When organising Sevyn8 files, use this structure:

```
sevyn8/
├── clients/
│   ├── body-shop/
│   ├── display-data/
│   ├── vmukti/
│   ├── nash/
│   └── swiss-re/
├── platform/
│   ├── cortex/
│   ├── dis/
│   ├── edge-hardware/
│   └── hal/
├── fundraise/
│   ├── pitch-deck/
│   ├── financial-model/
│   └── investor-comms/
├── internal/
│   ├── strategy/
│   ├── competitive/
│   └── team/
└── website/
```

---

## Working Style

Seema demonstrates a strong builder's working style — iterative, detail-oriented, and strategic. When working on Sevyn8 tasks:

- **Prefer complete execution over partial work.** Don't deliver outlines when full documents are requested.
- **Proactively identify gaps.** If something is missing or inconsistent, flag it rather than glossing over it.
- **Be operationally useful.** Every document should be lean, grounded in verifiable facts, and ready to send or present.
- **Pull back from over-specification to higher-level clarity** when the detail isn't adding value.
- **Low-friction input methods.** Don't ask 10 clarifying questions when you can make reasonable assumptions and note them.

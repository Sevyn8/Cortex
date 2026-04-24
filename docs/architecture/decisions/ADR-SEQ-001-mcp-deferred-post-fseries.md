# ADR-SEQ-001: Defer P0.8 MCP scaffolding to post-F-series

**Status:** Accepted
**Date:** 2026-04-24
**Deciders:** Amit (Sevyn8 engineering)
**Supersedes:** partial re-sequencing of P0.8 slot in `docs/build-prompts/cortex_build_prompts_v3.md` and `docs/progress/status.md`
**Companion decisions:** ADR-MCP-001 (MCP architecture — unchanged), ADR-OBS-001 (observability baseline — P0.6 Phase 2 library slot shifts as a consequence)

---

## Context

Original sequencing placed P0.8 (MCP server scaffolding + protocol-agnostic tool platform) in Phase 0, between P0.7 and P0.9. In practice, MCP servers need tools to register, and tools come from domain services that ship in Phase 1 Foundation Layer (F01–F05). The Phase-0 version of P0.8 per build_prompts §P0.8 is explicit about this: "zero tools at P0.8. A trivial health tool may be registered per-server for protocol handshake testing, but no business logic."

For a 2-person team on customer-delivery priority (Phase 1 Display Data Go-Live), landing MCP before F-services means building protocol scaffolding with nothing to expose beyond health endpoints. The scaffolding is not wrong — ADR-MCP-001's decision (MCP-native, three-server decomposition with protocol-agnostic tool platform) still holds. What shifts is WHEN the scaffolding ships.

## Decision

Defer P0.8 MCP scaffolding to after F05 (end of Phase 1 Foundation Layer). MCP lands when F-services are in place to provide real tools, and when the `@cortex/observability` library (P0.6 Phase 2) and `@cortex/audit-events` library (P0.10) are both available for MCP server imports per their consumer contract.

## Consequences

- P0.8 dependencies expand. Build_prompts §P0.8 line 669 updates from `P0.1 (monorepo), P0.6 (observability), P0.7 (secrets)` to `P0.1 (monorepo), P0.6 (observability — both Phase 1 operator infra AND Phase 2 library), P0.7 (secrets), F01–F05 (services providing tools to register)`.
- Phase 0 gate definition changes: P0.8 removed from Phase 0. Revised Phase 0 tail is `P0.7 → P0.6 Phase 2 library → P0.9 → P0.10`.
- Trust-model ADRs (ADR-MCP-002 mcp-cortex-core, ADR-MCP-003 mcp-edge, ADR-MCP-004 mcp-admin-ops) remain stubs until P0.8 runs. Per ADR-MCP-001 §References, each flesh-out "when the first tool for each server is implemented" — now naturally aligned with P0.8 landing after F-services exist.
- No impact on other Phase 0 items. P0.9 (Super Admin bootstrap) and P0.10 (Audit event emission convention) both stay in Phase 0; their dependencies (P0.3, P0.7 for P0.9; P0.6 for P0.10) are independent of MCP.
- P0.6 Phase 3 dashboards separately deferred indefinitely per `docs/progress/status.md` — no hard consumer, trigger on operator ask. Not governed by this ADR.

## Amendment 2026-04-24 — P0.9 and P0.6 Phase 2 library are independent

The Phase 0 tail stated in Consequences reads as a strict sequence. Re-examining the dependency graph: P0.9 and P0.6 Phase 2 library are independent; only P0.10 has a hard dependency on Phase 2 library.

P0.9 (Super Admin bootstrap) depends only on P0.3 (infra) + P0.7 (secrets). It does not consume `@cortex/observability`. Like P0.7 before it, P0.9 can use the interim stderr audit pattern (`[P0.9-AUDIT]` prefix) until the library lands and consumers swap.

P0.6 Phase 2 library is a hard gate ONLY for P0.10 (audit event emission — consumes observability for its own logging).

Corrected Phase 0 tail:

- P0.7 Secret Manager + KMS (done)
- P0.9 Super Admin bootstrap — no hard dep on Phase 2 library
- P0.6 Phase 2 `@cortex/observability` library — hard gate for P0.10
- P0.10 Audit event emission convention

P0.9 and Phase 2 library are independent; either can land first. Reprioritize based on operational need.

## References

- ADR-MCP-001 — MCP architecture (authoritative for WHAT MCP is; unchanged)
- ADR-OBS-001 — Observability baseline (Phase 2 library's slot follows from this ADR's consequences)
- `docs/build-prompts/cortex_build_prompts_v3.md` §P0.8 — dependencies + sequencing note updated in the same commit
- `docs/progress/status.md` — Phase 0/1 reshape captured in the same commit

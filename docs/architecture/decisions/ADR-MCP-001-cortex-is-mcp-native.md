# ADR-MCP-001: Cortex is MCP-Native — Three-Server Decomposition with Protocol-Agnostic Tool Platform

**Status:** Accepted
**Date:** April 2026
**Deciders:** Neerj (Sevyn8 engineering)
**Companion decisions:** ADR-INFRA-001 (event bus), ADR-SCOPE-009 (ROOS boundary)
**Affects:** P0.8, all subsequent module prompts that expose capabilities, Spec §Part VII-b

---

## Context

Cortex serves three distinct consumer categories:

1. **Humans** — operating admin consoles and analytical screens via the web UI
2. **Automated systems** — external SaaS platforms, partner integrations (Ithina's ROOS), customer backends calling Cortex via REST APIs
3. **AI agents** — a rapidly growing category that includes (a) Cortex's own internal agents (Planogram, PAC, Promotion, Perishable), (b) external AI agent platforms (Claude Desktop, Cursor, enterprise AI assistants), (c) third-party agents built by customers and integrators to automate their operations against Cortex

The first two categories are well-served by standard web APIs. The third — AI agents — is the architectural question this ADR resolves.

Two adjacent trends forced this decision:

**Agent-mediated access to business systems is becoming table stakes.** Claude Desktop, Cursor, ChatGPT's app integrations, Google's Agent Development Kit, and the broader agentic tooling ecosystem are converging on a shared expectation: SaaS platforms should be discoverable and operable by AI agents without custom integration code per consumer. In 2025 this was a differentiator. By 2027-2028 it will be as basic as "has a REST API" was in 2015. Platforms that ship without agent-nativity in this window will be retrofitting under competitive pressure rather than shipping on their own terms.

**Sevyn8's positioning specifically demands agent-nativity.** Cortex is not a generic B2B SaaS. It is a vertical intelligence platform that packages AI capabilities (CV, LLM reasoning, probabilistic identity resolution, decision pipelines) for retail clients. The core product promise is "AI-powered retail intelligence." A platform making that promise cannot credibly arrive without first-class agent interfaces — the contradiction would be legible to every technical buyer.

The Model Context Protocol (MCP), introduced by Anthropic in late 2024 and adopted across the agentic ecosystem through 2025, is the current best standard for making platforms agent-accessible. It specifies tool discovery, structured invocation, transport (HTTPS/SSE, stdio), and authentication patterns. Competing protocols exist (OpenAI's evolving "Apps" framework, Google's Agent-to-Agent protocol) but MCP has the broadest current adoption and Anthropic's commitment to long-term support. It is the reasonable bet for 2026.

## Decision

**Cortex is MCP-native.** This means:

1. **Three MCP servers form the agent-integration surface of Cortex**, each with a distinct trust boundary and consumer profile:
   - **`mcp-cortex-core`** — public MCP server, tenant-scoped. Consumers: tenant users, their AI agents (Claude Desktop, Cursor, enterprise AI), Cortex's internal agents operating across tenant boundaries, third-party agents built on Cortex.
   - **`mcp-edge`** — edge network zone MCP server. Consumers: edge devices (HHT apps, fixed cameras, edge-inference boxes), edge agents (local LLMs on future edge hardware), third-party edge integrators.
   - **`mcp-admin-ops`** — Sevyn8-only MCP server, privileged. Consumers: Sevyn8 CSMs and engineers operating the Cortex platform itself (provisioning tenants, cross-tenant investigation, incident response) through AI agents like Claude Code.

2. **Tool implementations live in `@cortex/*` packages**, not in the MCP servers themselves. MCP servers are thin adapters that expose registered tools over the MCP protocol. The actual capability — querying entities, triggering pipelines, provisioning tenants — is implemented once in typed TypeScript functions and reused across all access modes.

3. **A shared `@cortex/tool-registry` package maintains tool metadata** (name, description, input/output schemas via Zod, auth requirements, server assignment, audit requirements). Tools register once and servers pull from the registry. This decouples tool definition from protocol transport.

4. **Each server has a documented trust model** codified in a per-server ADR companion document (ADR-MCP-002 for mcp-cortex-core, ADR-MCP-003 for mcp-edge, ADR-MCP-004 for mcp-admin-ops). Permissions are explicit, audit is mandatory, cross-boundary tool calls are forbidden.

5. **The architecture is protocol-agnostic by construction.** Tools are defined as TypeScript functions with Zod schemas. MCP is the current protocol adapter. If MCP is superseded — by an MCP v2, a competing standard, or a post-MCP protocol — migration work is limited to the adapter layer. Underlying capabilities survive intact.

## Rationale

### Why three servers, not one or two

A single MCP server is simpler but collapses trust boundaries inappropriately. A tenant's agent must not be able to call Sevyn8-only admin tools even if the tool catalog is filtered — the server itself should not accept those requests from tenant-scoped credentials. A single server makes this a code concern; three servers make it a deployment and network concern.

Two servers (cloud + admin, skipping edge) was considered seriously. Rejected because it leaves edge as the one layer exposed to agents only via REST, and edge is where the next wave of agent integration is heading (local LLMs, agent-to-agent communication, edge-integrator ecosystems). Betting against agent-nativity at the edge is a concrete bet that retail edge devices will not become agent-driven in the next 3-5 years. Given the trajectory of on-device AI (Apple Intelligence, Qualcomm NPU-equipped SoCs, the broader hardware push), that bet has poor expected value.

Four or more servers was considered and rejected as over-decomposition. Three servers match exactly the trust boundary × network zone decomposition and further splits (by consumer type, by data sensitivity, by capability domain) either duplicate this matrix or create artificial separations.

**The three-server decomposition corresponds to three distinct operational concerns:**

| Dimension        | mcp-cortex-core                 | mcp-edge                             | mcp-admin-ops                     |
| ---------------- | ------------------------------- | ------------------------------------ | --------------------------------- |
| Network zone     | Cloud (public internet ingress) | Edge (device networks)               | Cloud (Sevyn8 VPC only)           |
| Trust boundary   | Tenant-scoped, multi-tenant     | Device-scoped, tenant-attributed     | Sevyn8-staff-scoped, cross-tenant |
| Auth             | OAuth2 via AC01 (per-tenant)    | Device credentials + AC01 delegation | Auth0 SSO + Super Admin role      |
| Rate limits      | Per-tenant, per-user            | Per-device                           | Per-Sevyn8-user                   |
| Audit            | SCR-20 per-tenant               | SCR-20 per-tenant (device events)    | SCR-20 cross-tenant + PR03 review |
| Scaling          | High concurrency                | Many low-rate clients                | Low concurrency                   |
| Cross-tenant ops | Forbidden                       | Forbidden                            | Explicit with audit gate          |

### Why capabilities live in packages, not servers

Three reasons:

1. **Reuse across access modes.** The same "query canonical entity" capability is called by the web UI (via tRPC), by REST API consumers (via O01), by internal agents (via direct function call), and by MCP clients (via MCP). Writing the implementation once and adapting it four ways is fundamentally cheaper than writing four parallel implementations with subtle drift.

2. **Protocol resilience.** If MCP is superseded in 2028, the work to adopt the successor protocol is "write a new adapter over the existing tool packages." Not "re-audit every platform capability." The capability investment compounds; the protocol choice is comparatively disposable.

3. **Testing and correctness.** Tools with typed schemas in packages are testable in isolation. Servers become thin — their correctness concern is protocol compliance and auth enforcement, not business logic. This is the pattern that scales.

### Why the tool-registry

Without a registry, every server must hardcode its tool catalog. This creates three problems: (a) adding a tool requires touching both the implementation package and a server, (b) tools that could serve multiple servers (e.g., a query-entity tool that makes sense in both core and admin with different auth) require duplicate declarations, (c) module prompts in the v3 plan would each need to know which server their tools attach to.

With a registry: modules declare tools and the registry records them. Servers query the registry for their assigned tools at startup. Adding a new tool is one place. Re-assigning a tool to a different server is a config change. Module prompts add tools without needing to touch any server's code.

### Why trust models are explicit and per-server

Multi-tenant platforms accumulate permission creep. A tool added for one use case gradually gets reused for adjacent cases, permissions erode at the edges, and by the time an audit catches it, there's no clear decision-maker for the drift. Documenting each server's trust model explicitly — what data flows through, what auth gates apply, what operations are categorically forbidden — gives future reviewers (including Sevyn8's own engineers a year from now) an anchor.

This becomes particularly important for mcp-admin-ops, which by design has cross-tenant access. The audit trail for cross-tenant operations is non-optional; it is a compliance artifact Sevyn8 produces for every Enterprise-tier client's DPA.

## Consequences

### Positive

- **Sevyn8 is agent-native from Phase 1.** Every tenant's AI tools, every future customer's custom agents, every evolving agent ecosystem integrates without Sevyn8 writing per-consumer glue.
- **Platform ambition is credible.** "Cortex is a vertical intelligence platform" becomes legible to technical buyers who can test by pointing their preferred AI client at a Cortex MCP endpoint.
- **Internal operations scale with AI.** Once Sevyn8 has 10+ tenants, CSMs operating via Claude Code against mcp-admin-ops is materially more productive than UI-driven operations. This is a direct cost-avoidance benefit as the tenant count grows.
- **No rework if MCP evolves.** Protocol migrations are bounded to the adapter layer.
- **No rework if agent-nativity expectations grow.** Adding more tools is marginal work per module; the infrastructure absorbs it.

### Negative

- **~4 weeks of Phase 1 engineering effort** distributed across P0.8 scaffolding (~3 days), per-module tool declarations (~5% overhead per module across ~40 modules), shared tool-registry implementation (~1 week), and per-server trust-model documentation and enforcement (~3 days).
- **Additional operational surface:** three servers to deploy, monitor, and secure. Mitigated by shared infrastructure (Cloud Run, Workload Identity, observability stack all Phase 0 foundation).
- **Documentation burden:** every capability exposed as a tool gets input/output schemas, descriptions, usage examples. Higher than REST alone. Pays back as AI agents (including Claude Code during the build) can use the tools effectively.
- **MCP SDK dependency.** Current TypeScript MCP SDK is actively evolving. Breaking changes possible. Mitigated by pinning SDK versions and staging upgrades.

### Neutral

- **Compliance implications.** MCP's OAuth2 flow integrates cleanly with AC01 (Auth0-backed). Audit-log integration is straightforward. DPDP reviewers receive the same audit artifacts whether access is UI-driven or MCP-driven; the access mode is metadata, not a compliance distinction.
- **Learning curve.** Engineers unfamiliar with MCP pay a one-time learning cost. No higher than any other protocol adoption.

## Alternatives considered

### Alternative 1: No MCP in Phase 1, build in Phase 2 when demand is concrete

Rejected. Phase 1 velocity savings (~4 weeks) are materially smaller than Phase 2 rework cost (~6-8 weeks). Additionally, 6-12 months of market positioning where Cortex looks agent-unfriendly is a commercial cost not captured by engineering time alone. The "forefront of tech" positioning Sevyn8 is pursuing requires agent-nativity as a built-in, not a retrofit.

### Alternative 2: Single MCP server, let permissions be code-level

Rejected. Collapsed trust boundaries are a recurring source of security incidents in multi-tenant platforms. Separating servers by trust boundary is a deployment-level enforcement that survives code errors. The marginal operational cost of three servers over one is small (shared infrastructure); the marginal security benefit is significant.

### Alternative 3: Two servers (cloud + admin, skip edge)

Rejected. See "Why three servers" above. Edge-as-REST is a bet against agent-mediated edge integration emerging in 3-5 years, which is a bet that has poor expected value given the trajectory of edge AI hardware and on-device LLMs.

### Alternative 4: Build on a different protocol (OpenAI Apps, Google A2A, custom)

Rejected. MCP has broader current adoption, Anthropic's commitment, and the cleanest match to Cortex's consumer profile (Claude Desktop, Cursor, and Claude Code integration works natively; equivalent for competing protocols would require custom client work). Protocol-agnostic tool platform architecture hedges against MCP being superseded; choosing a lesser-adopted protocol now would pay the same hedging cost without today's ecosystem benefit.

### Alternative 5: REST + OpenAPI as the agent integration surface

Rejected. While REST + rich OpenAPI documentation is technically sufficient for agents to discover and invoke tools, it requires every agent client to ship custom code per platform. MCP's discovery and invocation semantics mean zero custom client code per Cortex tool. The difference is a force multiplier for adoption.

## Implementation pattern

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Cortex capability layer (TypeScript functions, Zod schemas)            │
│                                                                         │
│  /packages/cortex-tools-core/    (entity queries, silver/gold writes)   │
│  /packages/cortex-tools-edge/    (device register, model push, health)  │
│  /packages/cortex-tools-admin/   (tenant provision, cross-tenant query) │
│  /packages/cortex-tools-shared/  (auth helpers, audit emitters)         │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  @cortex/tool-registry  (tool metadata, server assignment, auth specs)  │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────┬───────────────────┬──────────────────────────────┐
│  mcp-cortex-core     │  mcp-edge         │  mcp-admin-ops                   │
│  (tenant-scoped)     │  (edge zone)      │  (Sevyn8-only)               │
│                      │                   │                              │
│  Thin MCP adapter    │  Thin MCP adapter │  Thin MCP adapter            │
│  - HTTPS + SSE       │  - HTTPS + SSE    │  - HTTPS + SSE (VPC-only)    │
│  - OAuth2 via AC01   │  - Device creds   │  - Auth0 SSO + Super Admin   │
│  - Per-tenant audit  │  - Device audit   │  - Cross-tenant audit + PR03 │
└──────────────────────┴───────────────────┴──────────────────────────────┘
```

Tools flow from the capability layer up through the registry and are exposed by whichever server(s) the registry declares them for. A tool can belong to multiple servers with different auth profiles — e.g., a `query-entity` tool exists in mcp-cortex-core (tenant-scoped query within the requesting tenant) and in mcp-admin-ops (cross-tenant query with audit gate). The implementation is the same; the server and its auth middleware determine the scope.

### The `@cortex/tool-registry` API

```typescript
// Registration (by modules)
toolRegistry.register({
  name: 'query-canonical-entity',
  description: 'Query canonical entities by type, filter, and hierarchy scope.',
  inputSchema: QueryEntityInput,
  outputSchema: QueryEntityOutput,
  servers: ['mcp-cortex-core', 'mcp-admin-ops'],
  auth: {
    'mcp-cortex-core': { mode: 'tenant-scoped' },
    'mcp-admin-ops': { mode: 'cross-tenant-with-audit-gate' },
  },
  implementation: queryCanonicalEntity,
  audit: { category: 'read', severity: 'info' },
});

// Lookup (by servers at startup)
const tools = toolRegistry.toolsFor('mcp-cortex-core');
```

### Per-server trust model ADRs

To be drafted alongside their respective implementations:

- **ADR-MCP-002** — mcp-cortex-core trust model (referenced by P0.8, detailed before first module adds a tool there)
- **ADR-MCP-003** — mcp-edge trust model (referenced by P0.8, detailed before first edge module adds a tool there)
- **ADR-MCP-004** — mcp-admin-ops trust model (referenced by P0.8, detailed before first admin-ops tool is added)

These stay as thin stubs at P0.8 and are fleshed out when the first tool for each server is implemented.

## Revisit triggers

This decision should be revisited if any of the following happen:

- MCP v2 or a competing protocol (OpenAI Apps, Google A2A) achieves materially greater ecosystem adoption than MCP, and migration cost is bounded
- A Cortex client or partner requires a non-MCP agent protocol, and serving it alongside MCP becomes operationally burdensome
- Internal tool growth outpaces what three servers can cleanly serve (indicating a need to split further by capability domain)
- A major security incident reveals a categorical weakness in MCP's auth or transport model
- Anthropic deprecates MCP or materially changes its licensing/support posture

## References

- Anthropic MCP specification: https://modelcontextprotocol.io
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Cortex v2.2 Spec Part VII-b "The Case for MCP"
- Companion ADRs: ADR-INFRA-001 (event bus), ADR-SCOPE-009 (ROOS external)
- Forthcoming: ADR-MCP-002 (core trust model), ADR-MCP-003 (edge trust model), ADR-MCP-004 (admin trust model)

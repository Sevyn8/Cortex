# ADR-STACK-001: Auth0 as the Auth Provider

**Status:** Accepted
**Date:** June 2026
**Deciders:** Amit (Sevyn8 engineering). Sanjeev owns the identity and trust swimlane and is noted for the record (informational, not a ratification gate).
**Context documents:** `docs/spec/v3/architecture-spec.md` section 2.1 (identity plane); `docs/spec/v3/reconciliation.md` section 4; ADR-IDENTITY-001; `docs/build-prompts/cortex_build_prompts_v3.md` (the baked-defaults decision table and the stack-decision registry)
**Companion decisions:** ADR-IDENTITY-001 (Customer Master is the identity SSOT, AC01 / AC02 / AC03)

---

## Context

The v1 build prompts left the auth provider open ("Auth0 or WorkOS") and the v3 build prompts baked in WorkOS as the default, with the rationale of B2B multi-tenant focus and first-class Enterprise SSO. That default was never built.

Customer Master is the platform's identity SSOT (ADR-IDENTITY-001) and is Auth0-based: it was forked from `ithina-retail-admin-backend`, which uses Auth0 OIDC and SSO. The authoritative v3 specs already say Auth0: `architecture-spec.md` section 2.1 ("Auth0 OIDC and SSO for users, machines, and (future) agents") and ADR-IDENTITY-001 both specify it. Architecture-spec invariant 3 (one identity authority: nothing in the platform re-validates what Customer Master asserts) means the platform follows CM's provider rather than standing up a second one.

The live Auth0 estate is already built: the CM verifier and Management-API provisioning and the Auth0 Login Action, and the DIS token verifier has been conformed to it. The remaining drift is documentary: the v3 build prompts and several operational docs still say WorkOS, and the build-prompt registry references ADR-STACK-001 for the auth-provider decision while no such ADR file exists.

## Decision

Cortex uses Auth0 as the OIDC and SSO auth provider, superseding the WorkOS default in the v3 build prompts.

1. There is one identity authority: Customer Master, which is Auth0-based. The platform does not stand up a second auth provider.
2. The admin-console and landing-page login, tenant invites, session revocation, and the Super Admin bootstrap all target Auth0.
3. The v3 build prompts and the operational auth-flow docs are retargeted from WorkOS to Auth0 (this PR).
4. This decision is Accepted. There is no external ratification gate; the identity-authority invariant and the already-built Auth0 estate settle it.

## Consequences

- The build prompts (Category A authoritative decisions) and the operational docs (super-admin bootstrap, tenant-lifecycle, F02 scope, ADR-MCP-001, local-development) are retargeted WorkOS to Auth0 in this PR.
- The already-built Auth0 estate (the CM Auth0 client, Management-API provisioning, and Login Action; the DIS verifier conformance) is now spec-aligned: the docs match what is built.
- WorkOS is removed as a sub-processor and a dependency going forward. Historical progress records (`docs/progress/status.md`) are left as-is, because they record what happened, not what is current.
- Factual infra enumerations (egress allowlist examples) drop WorkOS in favor of Auth0 as a representative third-party API.
- A code-conformance follow-up remains (out of scope for this docs-only change): the bootstrap scripts (`scripts/bootstrap/`) and the canonical-schema comment still describe the production WorkOS path and are retargeted separately.

## References

- `docs/spec/v3/architecture-spec.md` section 2.1 (identity plane, "Auth0 OIDC and SSO")
- `docs/spec/v3/reconciliation.md` section 4 (Customer Master identity authority)
- ADR-IDENTITY-001 (Customer Master implements AC01, AC02, AC03)
- `docs/build-prompts/cortex_build_prompts_v3.md` (baked-defaults decision table; stack-decision registry row for ADR-STACK-001)

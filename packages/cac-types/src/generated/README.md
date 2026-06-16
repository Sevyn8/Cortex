# Generated types (contracts repo seam)

Types here are **generated from the contracts repo schemas**. Do not hand-edit.

Status: interim local stand-ins (ADR-CAC-002). The `sevyn8/contracts` repo does
not exist yet (it is stood up in Phase R per `docs/spec/v3/plan.md`). It is the
canonical, language-neutral source for the six frozen contracts (C1 machine-auth
token, C2 spine event envelope, C3 action ledger, C4 merge adjudication, C5
consent, C6 pack). Until codegen lands, `index.ts` here hand-authors the CAC
facts the funnel work needs (`funnel_event`, `cost_line`) as plain Zod shapes,
deliberately swappable for the generated C2 modules. These are the one
exception to the do-not-hand-edit rule and are removed when codegen replaces
them.

Cross-swimlane shapes (the RBAC vocabulary, identity resolution, the action
ledger, the policy gate) are owned by Customer Master and routed through the
contracts repo, never authored here. When codegen lands, generated modules are
emitted here and re-exported from `index.ts`.

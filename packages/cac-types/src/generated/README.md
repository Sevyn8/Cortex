# Generated types (contracts repo seam)

Types here are **generated from the contracts repo schemas**. Do not hand-edit.

Status: empty placeholder. The `sevyn8/contracts` repo does not exist yet (it is
stood up in Phase R per `docs/spec/v3/plan.md`). It is the canonical, language-
neutral source for the six frozen contracts (C1 machine-auth token, C2 spine
event envelope, C3 action ledger, C4 merge adjudication, C5 consent, C6 pack).

Cross-swimlane shapes (the RBAC vocabulary, identity resolution, the action
ledger, the policy gate) are owned by Customer Master and routed through the
contracts repo, never authored here. When codegen lands, generated modules are
emitted here and re-exported from `index.ts`.

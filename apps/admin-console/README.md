# @cortex/admin-console

The Cortex console (Atlas workbench shell). Next.js (App Router) + Tailwind 4.

Routes:

- `/` — console home.
- `/cac` — insurance acquisition funnel surface (pack experience).
- `/cac/admin` — insurance pack and tenant configuration surface.

## Pack-experience framing (ADR-CAC-001)

The CAC area is a pack-experience surface, not a bespoke module. The funnel and
dashboards render via the engine archetypes (funnel, dashboard, work queue;
V3-UX01-FR-002) over the Atlas V3-INS pack. Those archetypes are Phase 2
experience-engine work and are not built yet, so the routes here are documented
placeholder shells.

## Auth boundary (placeholder)

`lib/cm-auth-boundary.tsx` is a **placeholder** for the Customer Master auth
integration. Identity, RBAC, RLS, the action ledger, and the policy gate are
CM-owned (ADR-IDENTITY-001) and reached only through the contracts repo (C1
machine-auth token). The placeholder renders children and evaluates no policy;
it is swapped for the real C1 check once that contract lands.

## Local run

```sh
pnpm --filter @cortex/admin-console dev   # http://localhost:3000
```

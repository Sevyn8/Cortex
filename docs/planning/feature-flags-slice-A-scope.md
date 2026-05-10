# P1.6 Slice A — Core surface (server-side)

> Cross-ref: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice A.
>
> **Populated at slice kickoff (HOLD #1).** This file is a placeholder created during P1.6 module-scoping so the per-slice scope-doc convention is in place when Slice A starts.

## §1 Slice goal

Land the `@cortex/feature-flags` package skeleton + flag-definition Zod schema + server-side `isEnabled` / `getVariant` APIs + percentage-rollout helper + 4 initial flags registered. This is the load-bearing slice — Slice B + C build on the API surface this slice ships.

`registerConfigConsumer` adoption with `feature-flags` namespace + `ttl=30` (D1) gives the criterion-1 30s propagation requirement for free.

## §2 Phase plan

Populated at slice HOLD #1. Anticipated phases:

- **A.1** — Package skeleton (`package.json`, `tsconfig.json`, `tsconfig.build.json`, lint/test config).
- **A.2** — Flag-definition Zod schema (discriminated-union by `type` field; boolean / variant / percentage).
- **A.3** — `registration.ts` — `registerConfigConsumer` wiring with `ttl=30`.
- **A.4** — `eval.ts` — `isEnabled(client, tenantId, userId?, flagKey)` + `getVariant(client, tenantId, userId?, flagKey)`.
- **A.5** — `rollout.ts` — `SHA-256(userId+flagKey)` percentage-bucket helper.
- **A.6** — `initial-flags.ts` — register the 4 named flags from build-prompt.
- **A.7** — Tests + workspace regression.

## §3 Q-NEW recommendations (pre-defined from module-scope §4)

- **Q-NEW-FF-A-1** — Flag-definition Zod schema shape: discriminated union by `type` field. **Recommendation: yes** (compile-time exhaustiveness via `z.discriminatedUnion`). Lock at HOLD #1.
- **Q-NEW-FF-A-2** — Hash function for percentage rollout. **Recommendation: SHA-256 truncated** (deterministic + collision-resistant + simple; workspace hash convention). Lock at HOLD #1.

Additional Q-NEW items may surface during HOLD #1.

## §4 File surface anticipated

- `packages/feature-flags/package.json` (NEW) — `@cortex/feature-flags` workspace package.
- `packages/feature-flags/tsconfig.json` + `tsconfig.build.json` (NEW).
- `packages/feature-flags/src/index.ts` (NEW) — barrel.
- `packages/feature-flags/src/registration.ts` (NEW) — Zod schema + `registerConfigConsumer` adoption.
- `packages/feature-flags/src/eval.ts` (NEW) — `isEnabled` + `getVariant`.
- `packages/feature-flags/src/rollout.ts` (NEW) — SHA-256 percentage-bucket helper.
- `packages/feature-flags/src/initial-flags.ts` (NEW) — 4 named flags from build-prompt.
- `packages/feature-flags/test/{eval,rollout,registration,initial-flags}.spec.ts` (NEW).

## §5 Effort estimate

3-4 hr per module-scope §6. Largest of the 3 slices — all the API-shape decisions land here.

## §6 Locks

Populated at slice HOLD #1.

## §7 Lessons

Populated at slice close.

## §8 Cross-references

- Module scope: `docs/planning/p1.6-feature-flags-scope.md` §2 + §3 (D1 namespace, D2 flag types, D3 server API shape, D5 audit deviation, D6 default-value strategy, D7 percentage rollout).
- F04 surfaces consumed: `getConfig` / `resolveConfig` / `registerConfigConsumer` / `promoteDraft` from `@cortex/config-plane`.
- Live consumer reference: `packages/temporal-query/src/scd-policy.ts` (F03 Slice C uses raw `registerNamespaceSchema`; P1.6 uses `registerConfigConsumer` — both supported).
- Build-prompt: §P1.6 lines 1223-1224 (flag-definition shape + `flag.isEnabled(tenantId, userId)` signature).

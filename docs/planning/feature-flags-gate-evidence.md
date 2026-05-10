# P1.6 Feature Flags — Module gate evidence

> Captured 2026-05-10 at P1.6 module close (Slice C land). Second module-shape close on the day after F04. P1.6 ships as a thin consumer of F04's substrate per F04 D6 lock.
> Module scope: `docs/planning/p1.6-feature-flags-scope.md`
> Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.6 (lines 1211-1248)
> Day-of PR lineage: PR #13 (scoping) → #14 (Slice A core surface) → #15 (Slice B HTTP endpoint + client shim) → #16 (Slice C admin UI stub + module close)

## §1 Build-prompt acceptance criteria

| #   | Criterion (build-prompt §P1.6 lines 1242-1246)                         | Status         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Flag changes propagate to clients within 30s                           | PASS           | Slice A registers F04 consumer with `ttl=30` (per Q-NEW-FF-A-3 + Q-NEW-FF-B-4 locks); Slice B's `createFeatureFlagsClient` polls at 30s default + diff-notifies subscribers on value change. Single-replica deploy gets exact consistency on the local replica; multi-replica deploy gets up-to-TTL staleness (Redis broadcast deferred to roadmap §1.12 — acknowledged in `f04-gate-evidence.md` §6). 16 client specs in `packages/feature-flags/test/client.spec.ts` exercise polling. |
| 2   | Admin UI stub exists                                                   | PASS           | Slice C ships `packages/feature-flags/admin-stub/index.html` (~270 lines vanilla HTML + JS; no React, no bundler). Per Q-NEW-FF-C-1 lock (option d): colocated with the package, honoring the module-scope prediction at PR #13. SCR-04 ships full interactive admin UI with React + mutation routes in Phase 2.                                                                                                                                                                         |
| 3   | Module-close commit `feat(feature-flags): feature flag service on F04` | PASS (Slice C) | Per Q-NEW-FF-C-5 lock: two-commit composition. Commit 1 `feat(feature-flags-c): admin UI stub + module wrap-up` lands the slice; Commit 2 `feat(feature-flags): feature flag service on F04` lands the module-close summary. Build-prompt's literal subject is honored — sets non-F-module module-close commit precedent (P-prefix modules use package-name scope rather than module-id like `feat(F04)`).                                                                               |

## §2 Module-level locks (D1-D8) honored across 3 slices

| Lock                                                                                                  | Implementation site                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** — Storage substrate: reuse `tenant_config_version` with `feature-flags` namespace              | Slice A `packages/feature-flags/src/registration.ts:117` registers F04 consumer with namespace literal `feature-flags`. Naming reconciliation locked at D1: F04 D6's earlier `flags.*` draft superseded by `feature-flags` (matches package name `@cortex/feature-flags`).                                                                                 |
| **D2** — Type system: boolean + variant + numeric percentage; attribute-based targeting Phase 2       | Slice A `registration.ts` ships 3 per-type Zod schemas + `z.discriminatedUnion('type', [...])` mirroring F03 Slice C `SCDEntityPolicySchema` precedent. Variant flag's `assertVariantConsistent` cross-field invariant extracted because `.refine()` produces `ZodEffects` which `z.discriminatedUnion` rejects.                                           |
| **D3** — API shape: server APIs + non-React shim + documented React-hook recipe                       | Slice A `eval.ts` ships server APIs (`isEnabled` + `getVariant` + `evaluateAllFlags`); Slice B `client.ts` ships non-React shim; Slice C `docs/architecture/feature-flags.md` §4 documents React-hook recipe. React infrastructure ADR-FE-001 ships with SCR-04 in Phase 2.                                                                                |
| **D4** — Override mechanism: config-only changes via F04 lifecycle                                    | Flag changes go through F04's `promoteDraft` on `tenant.feature-flags` namespace; runtime overrides explicitly out of scope. F04 lifecycle's audit + impact-analysis primitives apply.                                                                                                                                                                     |
| **D5** — Audit catalog: per-flag-change via F04's `CONFIG_VERSION_PROMOTED`; per-evaluation deferred  | DEVIATION from build-prompt literal "all flag evaluations logged" rationale documented in `docs/architecture/feature-flags.md` §5. Per-evaluation at scale would dwarf F04's audit volume. Per-session-first-evaluation deferred to Phase 2 if observability requires.                                                                                     |
| **D6** — Per-flag default declared in registration; falls back to `false`                             | Slice A `initial-flags.ts` declares per-flag defaults for the 4 build-prompt flags. Empty registration → `false` fallback in `eval.ts`'s `evaluateBoolean` switch.                                                                                                                                                                                         |
| **D7** — Percentage-based per-tenant rollout Phase 1 (deterministic SHA-256); attribute-based Phase 2 | Slice A `rollout.ts` ships `rolloutBucket(userId, flagKey)` via `node:crypto` SHA-256(input).digest().readUInt32BE(0) % 100. First crypto-hash consumer in workspace src. 7 specs in `rollout.spec.ts` cover determinism + distribution + edge cases.                                                                                                      |
| **D8** — Phase 2 boundary explicit                                                                    | `docs/architecture/feature-flags.md` §7 + this gate evidence document the deferred surface: full Admin UI (SCR-04), attribute-based targeting (AC01-coupled), multi-replica cache invalidation (roadmap §1.12), per-evaluation audit (per D5), per-flag TTL override, SSE, AC01 auth wire-up on `apps/feature-flags-api`, multi-consumer registry (§1.16). |

## §3 Q-NEW-FF lock summary across all slices

**Slice A (Q-NEW-FF-A 1-6):**

- A-1 ✓ — 3-discriminated-union schemas + namespace record. Mirrors F03 Slice C precedent.
- A-2 ✓ — SHA-256 first-4-bytes-mod-100 percentage hash; deterministic; no salt; no tenant_id input.
- A-3 ✓ — Hybrid `(client, tenantId, params)` signature matching F04 `promoteDraft` precedent.
- A-4 ✓ — **HOLD #1 OVERRIDE** of operator's initial explicit-caller lean → eager top-level registration matching F03 Slice C `scd-policy.ts:177` workspace precedent.
- A-5 ✓ — Real F04 substrate via `@cortex/test-db-harness`; tests register custom flag-sets + INSERT tier rows directly via `pgPool`.
- A-6 ✓ — Per-key tier-walk in `eval.ts` (load-bearing); P1.6 ships own per-process LRU mirroring F04 `cache.ts` (~25 LOC + ~85 LOC). Roadmap §1.18 captures abstraction trigger.

**Slice B (Q-NEW-FF-B 1-5):**

- B-1 ✓ — (e) HTTP endpoint in Slice B + admin UI in Slice C. `apps/feature-flags-api` is N=2 apps-level Hono service; per-module-HTTP-service pattern review deferred to N=3 (slice scope doc only; not roadmap-tracked).
- B-2 ✓ — Bulk fetch `GET /v1/feature-flags?userId=<userId>` returns `{ flags: { [flagKey]: { type, value } } }`.
- B-3 ✓ — Trust-the-header auth (Phase 1); AC01 enforcement deferred to P2.1; `// TODO(AC01)` marker in `app.ts`.
- B-4 ✓ — Polling at 30s default + `pollIntervalMs` configurable + `refresh()` API; SSE deferred to Phase 2.
- B-5 ✓ — Convention doc landed in Slice C (consolidated with module-close docs work).

**Slice C (Q-NEW-FF-C 1-5):**

- C-1 ✓ — (d) `packages/feature-flags/admin-stub/index.html` per module-scope prediction at PR #13. Pure HTML + vanilla JS; no React, no bundler.
- C-2 ✓ — 8-section convention doc at `docs/architecture/feature-flags.md` (literal name per build-prompt §P1.6 line 1229; deviates from workspace `<concept>-convention.md` pattern; deviation noted in CLAUDE.md `## Coding conventions`).
- C-3 ✓ — F03-Slice-B-style gate evidence at `docs/planning/feature-flags-gate-evidence.md` (this file) mirroring `f04-gate-evidence.md` structure.
- C-4 ✓ — Single-row flip at `docs/progress/status.md` line 79 with full module-close summary block matching F04's line 77 precedent.
- C-5 ✓ — Two-commit composition matching F04 Slice E Q-NEW-F04E-5 precedent. Build-prompt's literal subject `feat(feature-flags): feature flag service on F04` honored.

## §4 Per-slice phase summary

| Slice                                  | Effort (estimate)                                          | Effort (actual) | PR         | Closing commit                                                                    |
| -------------------------------------- | ---------------------------------------------------------- | --------------- | ---------- | --------------------------------------------------------------------------------- |
| **A** — Core surface (server-side)     | 3-4 hr                                                     | ~4 hr           | #14        | `261af00 feat(feature-flags-a): core surface`                                     |
| **B** — HTTP endpoint + client shim    | 2-3 hr (operator) → 4-4.5 hr (after Q-NEW-FF-B-1 (e) lock) | ~3.65 hr        | #15        | `87d656d feat(feature-flags-b): http endpoint + client shim`                      |
| **C** — Admin UI stub + module wrap-up | 1-1.5 hr                                                   | ~1.75 hr        | #16 (this) | `feat(feature-flags-c): ...` + `feat(feature-flags): feature flag service on F04` |
| **Module total**                       | 6-9 hr                                                     | **~9.4 hr**     | 4 PRs      |                                                                                   |

Module-total slightly above 6-9 hr range — Q-NEW-FF-B-1 (e) HOLD #1 lock accepted the overrun for end-to-end demo coherence at module close. Trade-off justified: Slice B ships the HTTP transport that Slice C consumes, vs option (d) which would have left admin UI as a stub-only.

## §5 Cross-feature impact

**F04 substrate consumer (named first per F04 D6).** P1.6 is the canonical reference for F04 substrate consumption — the pattern P1.6 establishes (Zod schema registration → `registerConfigConsumer` adoption → `getConfig` per-tier reads → per-key precedence merge → own per-process LRU cache) is how every future F04 consumer integrates. Pattern documented in `docs/architecture/feature-flags.md` + `docs/planning/feature-flags-slice-A-scope.md` §6.

**SCR-04 Configuration screen — Phase 2 admin UI replacement.** P1.6 Slice C's static HTML stub is throwaway by design; SCR-04 ships the full admin UI with React + bundler + mutation routes (toggle / promote / rollback) in Phase 2. ADR-FE-001 (React infrastructure) ships at SCR-04 ship.

**AC01 wire-up — Phase 2 enforcement.** P1.6 Slice B's `apps/feature-flags-api` runs trust-the-header auth in Phase 1 (`// TODO(AC01)` marker). When AC01 (P2.1) ships, the `rejectMissingTenant: true` tenant-context middleware swaps for AC01's role-checking middleware. Internal-only Phase 1 surface; not production-facing pre-AC01.

**Workspace-wide consumer.** Build-prompt §399 + CLAUDE.md line 740 directive: "All new capabilities roll out behind a feature flag (`@cortex/feature-flags`)". Every future Cortex capability becomes a P1.6 consumer.

**A02 champion/challenger.** Build-prompt §3316 references `@cortex/feature-flags` as the consumer of `agents.planogram.v2-model` for gradual model rollout. Phase 1 Slice A registered the variant flag; A02 wire-up lands when A02 ships.

**Roadmap entries surfaced during P1.6:**

- §1.18 — per-key tier-walk abstraction trigger (Slice A finding).
- §1.19 — `runWithBoundTenantClient` extraction trigger (Slice B finding).

## §6 Test inventory at module close

**68 specs total** across two packages. No Slice C delta — admin UI stub is a static HTML asset; convention doc + gate evidence are markdown.

| Package                     | Specs | Slice mix                                                                                                                     |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@cortex/feature-flags`     | 61    | rollout (7) + registration (14) + initial-flags (7) + eval (17) + client (16) — Slices A + B                                  |
| `@cortex/feature-flags-api` | 7     | routes/v1/feature-flags (bulk fetch + per-type + missing-header + userId + tenant override + multi-tenant + health) — Slice B |

Workspace regression at module close: `@cortex/config-plane` 121/121 stable; `@cortex/foundation` 84/84 stable; workspace typecheck across **33 packages** clean.

## §7 Cross-refs

- Module scope: `docs/planning/p1.6-feature-flags-scope.md` (D1-D8 + Q-NEW-FF-A/B/C surface).
- Per-slice scopes: `docs/planning/feature-flags-slice-{A,B,C}-scope.md`.
- Convention doc: `docs/architecture/feature-flags.md` (lifecycle + audit deviation + Phase 2 deferrals).
- Build prompt: `docs/build-prompts/cortex_build_prompts_v3.md` §P1.6 (canonical scope) + line 399 (workspace-wide flag-rollout rule) + line 3316 (A02 champion/challenger consumer).
- ADRs: ADR-DB-002 (RLS), ADR-DB-003 (audit chain), ADR-AU-001 (audit-events library), ADR-HTTP-001 (Hono).
- F04 precedents consumed: D6 thin-consumer lock, F04 lifecycle for flag changes, F04 cache TTL semantics for Slice A's TTL=30s alignment.
- F04 module-close precedent: `docs/planning/f04-gate-evidence.md` (this file's structural template per Q-NEW-FF-C-3 lock).
- Roadmap entries: §1.12 (multi-replica Redis cache trigger), §1.16 (multi-consumer-per-namespace constraint), §1.18 (per-key tier-walk abstraction), §1.19 (runWithBoundTenantClient extraction).

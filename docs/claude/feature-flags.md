# Feature flags (P1.6)

> Relocated from CLAUDE.md for context-budget; loaded on demand. The short workspace-wide
> flag-rollout rule remains inline in CLAUDE.md.

`@cortex/feature-flags` is the named first F04 consumer (per F04 D6). Three slices shipped 2026-05-10 (PRs #13-#16). Phase 1 surface:

- **Server APIs:** `isEnabled(client, tenantId, { flagKey, userId? })` + `getVariant(...)` + `evaluateAllFlags(...)`. All take a `Queryable` and require pre-bound RLS tenant context (caller responsibility).
- **HTTP endpoint:** `apps/feature-flags-api` ships `GET /v1/feature-flags?userId=...` bulk fetch (Hono-based; trust-the-header auth in Phase 1; AC01 swap is `// TODO(AC01)`).
- **Client shim:** `createFeatureFlagsClient({ baseUrl, tenantId, userId?, fetch?, pollIntervalMs? })` with `subscribe` / `getCachedValue` / `refresh` / `invalidate` / `dispose`. 30s default polling; diff-notify subscribers on value change.
- **Three flag types** (Q-NEW-FF-A-1): `boolean`, `variant`, `percentage` — `z.discriminatedUnion('type', [...])` mirroring F03 Slice C `SCDEntityPolicySchema` precedent.
- **Eager top-level registration** (Q-NEW-FF-A-4): `import '@cortex/feature-flags'` triggers `registerInitialFeatureFlags()` as a side effect, registering the 4 named build-prompt flags. Tests calling `resetConsumerRegistry()` re-register via the exported helper.

**Workspace-wide rule** (build-prompt §399 + line 740 above): all new capabilities roll out behind a feature flag. Every future module is a P1.6 consumer.

**Audit deviation** (Q-NEW-FF-D-5 + convention doc §5): per-flag-CHANGE audit only via F04's existing `CONFIG_VERSION_PROMOTED`. Per-evaluation logging (build-prompt's literal `"All flag evaluations logged for auditability via audit events"` directive) is untenable at scale — would dwarf F04's audit volume. Per-session-first-evaluation deferred to Phase 2 if observability requires.

**Roadmap entries surfaced during P1.6:**

- §1.18 — per-key tier-walk abstraction trigger (Slice A): F04's `resolveConfig` returns whole-tier JSON without merging; record-shaped namespaces need per-key precedence which P1.6 implements in `eval.ts` + private LRU. Extraction trigger at N≥2 record-shaped F04 consumer.
- §1.19 — `runWithBoundTenantClient` extraction trigger (Slice B): `apps/feature-flags-api`'s route handler inlines the RLS-bound transaction pattern because F02's `withTenantDbClient` uses drizzle tx (doesn't satisfy Queryable seam). Extraction trigger at N=2 app-level service needing the same pattern.

**Cross-refs:**

- `docs/architecture/feature-flags.md` — full convention doc (lifecycle + audit deviation + Phase 2 deferrals).
- `docs/planning/p1.6-feature-flags-scope.md` — module scope + D1-D8 locks.
- `docs/planning/feature-flags-slice-{A,B,C}-scope.md` — per-slice locks + lessons.
- `docs/planning/feature-flags-gate-evidence.md` — module gate evidence at close.

### P1.6 module close

P1.6 module CLOSED 2026-05-10 (same day as F04). Three slices shipped across 4 PRs: scoping (PR #13) → Slice A core surface (PR #14) → Slice B HTTP endpoint + client shim (PR #15; §1.19 surfaced) → Slice C admin UI stub + module close (PR #16). **Second module-shape close on the day after F04** — but P1.6 is non-F-shaped (cross-cutting feature management; no §F-level spec).

Module-close commit shape per Q-NEW-FF-C-5 lock: **two-commit composition mirroring F04 Slice E Q-NEW-F04E-5 precedent**. Commit 1 `feat(feature-flags-c): admin UI stub + module wrap-up` lands the slice work; commit 2 `feat(feature-flags): feature flag service on F04` lands the module-close summary (gate evidence + status flip + this CLAUDE.md ladder). Build-prompt's literal subject is honored — sets the **non-F-module module-close commit precedent** (P-prefix modules use package-name scope rather than module-id like `feat(F04)`).

**Gate evidence:** `docs/planning/feature-flags-gate-evidence.md` captures build-prompt acceptance × evidence (3 criteria); D1-D8 locks honored across slices; per-slice phase summary; cross-feature impact (F04 substrate consumer; SCR-04 + AC01 wire-ups Phase 2); test inventory at module close (68/68 stable).

**Downstream queue (post-P1.6):**

- **SCR-04 Configuration screen** — replaces Slice C HTML stub with full admin UI (React + bundler + mutation routes); ADR-FE-001 React infrastructure ships at SCR-04.
- **AC01 (P2.1)** — wires real auth on `apps/feature-flags-api` (Phase 2; `// TODO(AC01)` marker in Phase 1's app.ts).
- **A02 champion/challenger** — consumes `agents.planogram.v2-model` variant flag for gradual model rollout (per build-prompt §3316).
- **Workspace-wide flag-rollout rule** — every future capability per build-prompt §399.

# P1.6 Slice B — Client-side helpers (non-React shim)

> Cross-ref: `docs/planning/p1.6-feature-flags-scope.md` §2 Slice B.
>
> **Populated at slice kickoff (HOLD #1).** This file is a placeholder created during P1.6 module-scoping so the per-slice scope-doc convention is in place when Slice B starts.

## §1 Slice goal

Ship the framework-agnostic non-React shim (`subscribe` + `getCachedValue` + `invalidate`) for client-side flag evaluation. React-hook recipe documented but NOT shipped as code (Phase 1 ships the substrate; React infra ADR-FE-001 lands at SCR-04 ship per D3).

Subscriber receives callback within 30s of underlying flag change (criterion 1 propagation requirement). Cache survives across calls; `invalidate` clears.

## §2 Phase plan

Populated at slice HOLD #1. Anticipated phases:

- **B.1** — `client.ts` — `subscribe(flagKey, callback)` + `getCachedValue(flagKey)` + `invalidate(flagKey)` API.
- **B.2** — Subscription registry (EventEmitter-style OR Symbol-based per Q-NEW-FF-B-1 lock).
- **B.3** — Cache propagation (consumes Slice A's `isEnabled` / `getVariant` server APIs).
- **B.4** — Tests covering subscription + cache + invalidation semantics + 30s propagation.
- **B.5** — Initial draft of `docs/architecture/feature-flags.md` (lifecycle conventions; Slice C populates remaining sections).

## §3 Q-NEW recommendations (pre-defined from module-scope §4)

- **Q-NEW-FF-B-1** — Client API shape for non-React shim. **Recommendation:** `subscribe(flagKey, callback) → unsubscribe` + `getCachedValue(flagKey)` + `invalidate(flagKey)`. EventEmitter-style under the hood OR Symbol-based subscription registry. Lock at HOLD #1.

Additional Q-NEW items may surface during HOLD #1 — likely:

- Cache eviction policy for client (LRU vs TTL-only; Phase 1 reuses F04 cache pattern: TTL = 30s).
- React-hook recipe shape in convention doc (lean: thin `useFeatureFlag(flagKey)` example wrapping `subscribe` + `getCachedValue` + cleanup).

## §4 File surface anticipated

- `packages/feature-flags/src/client.ts` (NEW) — non-React shim.
- `packages/feature-flags/test/client.spec.ts` (NEW) — subscription + cache + invalidation tests.
- `docs/architecture/feature-flags.md` (NEW; partial draft — Slice C completes) — initial sections covering React-hook recipe with example.

## §5 Effort estimate

2-3 hr per module-scope §6. Smaller than Slice A; subscription substrate is the only novel surface.

## §6 Locks

Populated at slice HOLD #1.

## §7 Lessons

Populated at slice close.

## §8 Cross-references

- Module scope: `docs/planning/p1.6-feature-flags-scope.md` §2 + §3 (D3 client shim shape, D8 React infra deferral).
- Slice A's server APIs (`isEnabled` / `getVariant`) — Slice B consumes these.
- F04 cache pattern reference: `packages/config-plane/src/cache.ts` (per-process LRU + TTL).
- Future: ADR-FE-001 lands at SCR-04 ship — locks React-infra approach.

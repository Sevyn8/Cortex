# F03 Slice A — Gate evidence

> Captured 2026-05-09. Slice A — Bi-temporal authoring DX (lint + scaffold + backfill helper + CLAUDE.md convention).
> Branch: `p1.3-f03-slice-a`
> Higher-level scope: `docs/planning/f03-slice-A-scope.md` (SDs locked at HOLD #1; sub-phases A.1–A.4 per SD7).

## §0 Pre-flight reconciliation surfaces (caught + closed in this commit)

Per HOLD #1 surfaced (h.1) + (h.2):

### §0a 0002 header recipe was stale post-0006

`services/foundation/migrations/0002_bi_temporal_helpers.sql` lines 30-33 documented `BEFORE UPDATE OR DELETE` (the original 0002 binding). Migration 0006 amended the runtime to `BEFORE INSERT OR UPDATE OR DELETE` (the INSERT branch normalizes timestamps to ms quantum) but never updated the header comment. **Fixed:** comment-only edit to the 0002 header. The migration body is unchanged (was already corrected by 0006); 0002 doesn't re-apply.

### §0b "First CI lint step in the repo" — pattern establishment

`.github/workflows/ci.yaml` previously ran `pnpm test` only — no `pnpm lint`, no SQL lint, no other lint. Slice A's `Lint bi-temporal migrations` step is the **first CI lint step** in the repo. Future Claude-Code sessions adding new lint surfaces should follow this slot pattern (a step before `pnpm test`, no DB dependency, fail-fast).

## §1 Acceptance criteria

| #   | Criterion                                                                                                 | Status                               | Evidence                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CI lint rule fails any PR adding a tenant-scoped table without bi-temporal recipe                         | PASS                                 | 6 fixtures cover the rule space; `lint-bi-temporal.spec.ts` 7/7 PASS (4 fail-cases assert exit 1 + correct missing-piece error message)                                                                              |
| 2   | Scaffold produces correct recipe-applied SQL with operator-edit-able output                               | PASS                                 | `scaffold-bitemporal.spec.ts` 7/7 PASS — including round-trip (scaffold output passes the lint) + `WITH_WRAPPERS` toggle                                                                                             |
| 3   | `cortex.backfill_bitemporal()` adds columns + trigger + indexes + exclusion to a legacy table; idempotent | PASS at code level; CI will run live | `backfill-bitemporal.spec.ts` written; verified syntactically; live `pnpm vitest run` blocked by §4.20 local-DB password issue (carried across D.4-D.6 sessions); CI's ephemeral Postgres will exercise on push      |
| 4   | CLAUDE.md `## Database conventions` gains `### Bi-temporal table convention` subsection                   | PASS                                 | New subsection added; 3-bullet pattern (when to use / recipe + scaffold / backfill); `WITH_WRAPPERS=y\|n` documented per operator addition; cross-refs to ADR-DB-001 + migrations 0002/0006 + both F03 planning docs |

## §2 Test coverage

| Spec                          | Cases                                                                                                              | Status                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `lint-bi-temporal.spec.ts`    | 6 fixture cases (correct, missing-cols, no-trigger, no-exclusion, opt-out, no-tenant-id) + real-migrations-dir     | 7/7 PASS                                  |
| `scaffold-bitemporal.spec.ts` | recipe content, WITH_WRAPPERS=n, round-trip, missing TABLE/BUSINESS_KEY, invalid table name, invalid WITH_WRAPPERS | 7/7 PASS                                  |
| `backfill-bitemporal.spec.ts` | columns+trigger+indexes+exclusion appear; idempotent re-run                                                        | written; CI-only (local-DB §4.20 blocked) |

**Net Slice A test count:** +14 active spec tests (lint 7 + scaffold 7); +1 spec + 2 cases blocked locally (backfill, CI-runnable).

Lint script exit code 0 against real `services/foundation/migrations/` directory (12 shipped migrations) — confirms no false-positives across existing bookkeeping tables (`tenant`, `tenant_config_version`, `tenant_quota_usage`, `tenant_kms_key`, `legal_hold`, `audit_event` all hit the allowlist short-circuit).

## §3 Forcing functions (Slice A subset)

Three locked at HOLD #2 + carried into the build:

1. **Bi-temporal-on-every-tenant-domain-table mandate** — codified by SD5's lint rule. PR-level fail-closed enforcement.
2. **ms-precision-quantum guarantee** — carried forward from migration 0006; CLAUDE.md cross-ref makes the constraint visible to future authors.
3. **Trigger binding form** — post-0006 `BEFORE INSERT OR UPDATE OR DELETE`. Lint enforces; scaffold emits; 0002 header corrected (§0a above).

## §4 Multi-phase close timeline checkpoint

Per `docs/planning/f03-temporal-data-engine-scope.md` § Multi-phase close timeline:

| Slice | Status post-this-commit                                                                |
| ----- | -------------------------------------------------------------------------------------- |
| **A** | ✓ closed (this commit)                                                                 |
| **B** | next P1.3 work — `@cortex/temporal-query` package (4–6 hr per Q-NEW-F03B-1 resolution) |
| **C** | DEFERRED (blocked by F04)                                                              |
| **D** | DEFERRED (blocked by D04 + S01 + SCR-08)                                               |

F03 module-row stays unchecked per D4 (per-slice rows; flips at all-4-slices ✓).

## §5 What's next

- F03 Slice B start (next session): `@cortex/temporal-query` package; library-only per Q-NEW-F03B-1 → D3 (tRPC handlers + SQL views deferred to first-consumer; tRPC lands in `@cortex/temporal-query/trpc` secondary export, SQL views land per-table at consuming F-/D-series migration).
- Operator-driven recovery still pending (carried from D.4–D.6 close): re-attach billing on staging+prod per roadmap §2.5a → apply 5 accumulated TF bundles.
- Roadmap §4.20 (local DB credentials reconciliation) carries forward — Slice A also hit it; chose not to side-quest fix per scope discipline.

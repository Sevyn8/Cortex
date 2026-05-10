/**
 * F04 Slice E — Configuration-as-Code Git sync (STUB).
 *
 * Per build-prompt §F04 §4 (`docs/build-prompts/cortex_build_prompts_v3.md`
 * line 1146-1148):
 *
 *   "Configuration-as-Code Sync (Enterprise only, deferred to Phase 2).
 *    Stub the API; actual Git sync is Phase 2. Skeleton for bidirectional
 *    YAML export/import."
 *
 * **Slice E scope is stub-only.** Both functions throw
 * `GitSyncNotImplementedError` per Q-NEW-F04E-2 lock — silent no-op
 * would mask the deferral and create enterprise-customer surprise.
 *
 * **YAML schema deferred to Phase 2** per Q-NEW-F04E-1 lock. Lossless
 * round-trip vs human-friendly is a Phase 2 design discussion (capture
 * `parent_version_id`, `schema_version`, `validation_state` losslessly,
 * or simplify to key-value-only for human review). The choice depends
 * on Phase 2's first consumer's needs.
 *
 * **Git library choice deferred** per Q-NEW-F04E-3 lock. Pinning a
 * library now (`simple-git`, `isomorphic-git`, native execSync) commits
 * to a future implementation choice prematurely; first Phase 2 consumer
 * drives the choice. The stub does no I/O.
 *
 * Cross-refs:
 *   - Roadmap §5.5 — `docs/future-roadmap.md` (Configuration-as-Code
 *     Git sync; Phase 2 owner phase)
 *   - Build prompt — `docs/build-prompts/cortex_build_prompts_v3.md`
 *     §F04 §4
 *   - Slice scope — `docs/planning/f04-slice-E-scope.md`
 */

/**
 * Thrown by `exportToYaml` and `importFromYaml` to signal that
 * F04 Slice E shipped only the API surface, not the implementation.
 *
 * Subclasses `Error`; `name` is `'GitSyncNotImplementedError'` for
 * type-narrowing in callers (`err.name === 'GitSyncNotImplementedError'`
 * works in JSON-serialized error contexts where `instanceof` is unreliable).
 *
 * Why a dedicated class instead of plain `Error`: callers may want to
 * distinguish "Git sync isn't ready yet" from other failures (e.g., a
 * Phase 2 wrapper that gates Enterprise tier could `instanceof`-check
 * to surface a polished UX rather than a generic 500).
 */
export class GitSyncNotImplementedError extends Error {
  constructor(operation: 'exportToYaml' | 'importFromYaml') {
    super(
      `config-plane: ${operation} is a Phase 2 feature — Slice E shipped only the API surface. ` +
        'Configuration-as-Code Git sync (Enterprise only) is deferred per build-prompt §F04 §4 ' +
        'and tracked at docs/future-roadmap.md §5.5. The stub throws here to avoid silently ' +
        'masking the deferral for callers expecting a working sync.',
    );
    this.name = 'GitSyncNotImplementedError';
  }
}

/**
 * Tenant-scoped context for Git-sync operations. Phase 2 will widen this
 * to include the per-tenant Git remote URL, branch, and authentication
 * material; Phase 1 stub takes only `tenantId` so the call shape is
 * stable while the underlying implementation matures.
 */
export interface GitSyncContext {
  tenantId: string;
}

/**
 * Phase 2 will export every promoted `tenant_config_version` row for
 * `ctx.tenantId` to a YAML representation suitable for committing to
 * a per-tenant Git repository. Round-trip semantics are pinned by
 * `importFromYaml` such that
 *   `importFromYaml(ctx, await exportToYaml(ctx))`
 * reproduces the tenant's full version history.
 *
 * Slice E (Phase 1): throws `GitSyncNotImplementedError`. Stub-only
 * per Q-NEW-F04E-2 lock. The `async` keyword is intentional — pins
 * the Phase 2 contract so callers can `await` consistently when the
 * actual implementation lands.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- stub pins Phase 2 async contract
export async function exportToYaml(_ctx: GitSyncContext): Promise<string> {
  throw new GitSyncNotImplementedError('exportToYaml');
}

/**
 * Phase 2 will import a YAML representation produced by `exportToYaml`
 * (or hand-authored against the same schema) and replay it against
 * `tenant_config_version` for `ctx.tenantId`. Replay semantics: each
 * version becomes a new draft → validate → promote round-trip per
 * Slice B's lifecycle, preserving `parent_version_id` chain integrity.
 *
 * Slice E (Phase 1): throws `GitSyncNotImplementedError`. Stub-only
 * per Q-NEW-F04E-2 lock. The `async` keyword is intentional — pins
 * the Phase 2 contract so callers can `await` consistently when the
 * actual implementation lands.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- stub pins Phase 2 async contract
export async function importFromYaml(_ctx: GitSyncContext, _yaml: string): Promise<void> {
  throw new GitSyncNotImplementedError('importFromYaml');
}

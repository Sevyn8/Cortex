/**
 * F04 Slice D — `analyzeImpact` + structural JSON diff +
 * consumer keyPath intersection + multi-consumer aggregation.
 *
 * Per Q-NEW-F04D-2, breaking changes have three orthogonal axes:
 *   - **`key_removed`** (data-shape axis) — a key any impact-eligible
 *     consumer registered against is being removed by the draft. Detected
 *     via structural JSON diff between the current latest version's
 *     `config_json` and the draft's `draft_json`.
 *   - **`schema_incompatible`** (schema-version axis) — schema-version
 *     drift breaking consumer pins (consumer pinned at v=N; draft
 *     promoting at v=N+1 with a shape that fails v=N validation).
 *     Detected by `detectSchemaIncompatibilities` in `schema-drift.ts`
 *     (Slice D D.3); not yet wired here.
 *   - **`policy_block`** (registry-policy axis) — consumer registered
 *     `breakingChangePolicy: 'block'` and any change touched its
 *     keyPaths.
 *
 * Per Q-NEW-F04D-5, consumers register OPTIONAL `keyPaths`. When
 * provided, impact narrows to changes intersecting those paths. When
 * omitted (and `consumerModule` IS provided), the consumer is
 * "namespace-level" — any change touches it.
 *
 * Per Q-NEW-F04D-6, the diff is **structural JSON** (not Zod-semantic).
 * Phase 1 limitation: arrays compared **positionally**; semantic /
 * set-based array diff is deferred to first-consumer-driven. Documented
 * in CLAUDE.md `### Impact analysis`.
 *
 * **Genesis case** (no current version): diff is conceptually
 * "everything is added"; we deliberately skip diff-based detection
 * entirely (no breaking changes possible against an empty prior state)
 * and return an empty report. Schema-version drift detection still
 * applies (the draft might still violate a consumer's pinned schema).
 *
 * Caller responsibility: pre-bind tenant context on the
 * `NodePgDatabase` (matches lifecycle precedent — call inside an
 * already-bound transaction, OR open a fresh `db.transaction` and call
 * `bindTenant` first). RLS on `config_draft` + `tenant_config_version`
 * is defense-in-depth; the `tenantId` parameter ALSO appears in every
 * WHERE clause to keep the library robust against missing-bind callers
 * (would still see no rows due to RLS, but the explicit filter is the
 * obvious correctness gate).
 *
 * Drizzle-shaped vs Queryable-shaped — note that the Slice A read-API
 * (`getConfig`) + Slice C resolver (`resolveConfig`) take a `Queryable`
 * (raw `pg.PoolClient`-style). Slice D's `analyzeImpact` deliberately
 * takes a drizzle `NodePgDatabase` instead — it's transactional /
 * lifecycle-shaped, called from inside `attemptPromote`'s already-
 * existing drizzle transaction. External callers (HTTP "preview
 * impact" endpoints; not shipped Slice D) should wrap with `drizzle()`
 * around their `pg.Pool` to use this API.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getImpactEligibleConsumers, type BreakingChangePolicy } from './consumer-registry.js';
import { detectSchemaIncompatibilities } from './schema-drift.js';

// ──────────────────────────────────────────────────────────────────────
// Public types — exported from package barrel for HTTP-layer consumers
// (Q-NEW-F04D-8 lock).
// ──────────────────────────────────────────────────────────────────────

export type BreakingChangeKind = 'key_removed' | 'schema_incompatible' | 'policy_block';

export interface AffectedConsumer {
  consumer_module: string;
  namespace: string;
  matched_key_paths: string[];
  policy: BreakingChangePolicy;
}

export interface BreakingChange {
  kind: BreakingChangeKind;
  consumer_module: string;
  detail: string;
}

export interface Warning {
  /** Extensible enum string. Phase 1 emits no warnings (Slice D scope). */
  kind: string;
  consumer_module: string;
  detail: string;
}

export interface ImpactReport {
  affected_consumers: AffectedConsumer[];
  breaking_changes: BreakingChange[];
  warnings: Warning[];
}

// ──────────────────────────────────────────────────────────────────────
// Structural JSON diff
// ──────────────────────────────────────────────────────────────────────

export type DiffChangeKind = 'added' | 'removed' | 'modified';

export interface JsonDiffEntry {
  kind: DiffChangeKind;
  /** Dot-notation path. Array indices stringified (`'sections.0.title'`). */
  path: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursive structural diff between `before` and `after`. Returns an
 * array of leaf-level change entries. Object key insertions/deletions
 * report at the key path (do NOT recurse into the missing/new subtree —
 * the `pathMatchesKeyPath` matcher handles bidirectional path matching).
 *
 * Phase 1 array semantics: positional comparison. Inserting one element
 * at the front of an array reports every subsequent index as `modified`.
 * Real-world array-as-set diffing requires LCS or hash-based identity
 * tracking — deferred to first-consumer-driven.
 */
export function diffJson(before: unknown, after: unknown, prefix = ''): JsonDiffEntry[] {
  if (before === after) return [];

  if (isRecord(before) && isRecord(after)) {
    const out: JsonDiffEntry[] = [];
    const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      const inBefore = k in before;
      const inAfter = k in after;
      if (inBefore && !inAfter) {
        out.push({ kind: 'removed', path });
      } else if (!inBefore && inAfter) {
        out.push({ kind: 'added', path });
      } else {
        out.push(...diffJson(before[k], after[k], path));
      }
    }
    return out;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const out: JsonDiffEntry[] = [];
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      const path = prefix ? `${prefix}.${i}` : String(i);
      const inBefore = i < before.length;
      const inAfter = i < after.length;
      if (inBefore && !inAfter) {
        out.push({ kind: 'removed', path });
      } else if (!inBefore && inAfter) {
        out.push({ kind: 'added', path });
      } else {
        out.push(...diffJson(before[i], after[i], path));
      }
    }
    return out;
  }

  // Mixed types or primitives that differ — report as modified at current path.
  // (`prefix` is empty only for top-level primitive comparison; in practice
  // F04 config_json is always an object at the root.)
  return [{ kind: 'modified', path: prefix }];
}

/**
 * Bidirectional path match. A diff path `P` matches a registered keyPath
 * `K` if any of:
 *   - `P === K` (exact match)
 *   - `P.startsWith(K + '.')` (change deeper than registered path —
 *     consumer registered `'palette'`, change at `'palette.brand'`)
 *   - `K.startsWith(P + '.')` (registered path inside removed/added
 *     subtree — consumer registered `'palette.brand'`, whole `'palette'`
 *     object removed)
 */
export function pathMatchesKeyPath(diffPath: string, keyPath: string): boolean {
  if (diffPath === keyPath) return true;
  if (diffPath.startsWith(keyPath + '.')) return true;
  if (keyPath.startsWith(diffPath + '.')) return true;
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Tier-prefix stripping (literal namespace → logical namespace)
// ──────────────────────────────────────────────────────────────────────

const TIER_PREFIXES = ['tenant.', 'platform.', 'workspace.'] as const;

function stripTierPrefix(literalNamespace: string): string | null {
  for (const prefix of TIER_PREFIXES) {
    if (literalNamespace.startsWith(prefix)) {
      return literalNamespace.slice(prefix.length);
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// analyzeImpact
// ──────────────────────────────────────────────────────────────────────

export class ImpactAnalysisDraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(
      `config-plane: analyzeImpact could not find draft id=${JSON.stringify(draftId)}; ` +
        'either the draft does not exist or the caller did not bind tenant context (RLS).',
    );
    this.name = 'ImpactAnalysisDraftNotFoundError';
  }
}

// Drizzle's tx.execute<T> generic requires T extends
// Record<string, unknown> — named interfaces don't structurally
// satisfy without an explicit index signature, so the row types
// inline the constraint via `& Record<string, unknown>` semantics.
// Inline type literals work too; named-with-index-signature is the
// pattern documented in CLAUDE.md (Slice B's lifecycle.ts ran into
// the same constraint).
type DraftRow = {
  namespace: string;
  draft_json: unknown;
  schema_version: number;
} & Record<string, unknown>;

type CurrentVersionRow = {
  config_json: unknown;
} & Record<string, unknown>;

/**
 * Analyze a draft's promote-time impact on registered consumers.
 *
 * Pipeline:
 *   1. Fetch the draft (`namespace`, `draft_json`, `schema_version`).
 *   2. Strip tier prefix; look up impact-eligible consumers for the
 *      logical namespace.
 *   3. If no impact-eligible consumers, return an empty report
 *      (no consumers means nothing to break).
 *   4. Fetch the CURRENT latest version's `config_json` for the same
 *      `(tenant_id, namespace)` — what promote would supersede.
 *   5. Genesis case (no current version): return empty report. Schema-
 *      version drift detection (D.3) still applies but is not wired
 *      in this D.2 commit.
 *   6. Compute structural JSON diff.
 *   7. For each consumer:
 *      - If `keyPaths` undefined/empty: namespace-level — match if any
 *        change exists.
 *      - If `keyPaths` provided: match if any diff path bidirectionally
 *        matches any keyPath.
 *      - If matched: append to `affected_consumers` with the matched
 *        keyPaths (or `[]` for namespace-level).
 *      - For each REMOVED diff path matching the consumer: append
 *        `key_removed` breaking change.
 *      - If `breakingChangePolicy === 'block'` AND any change touched
 *        the consumer: append `policy_block` breaking change.
 *
 * Returns an `ImpactReport` whose three arrays are independently
 * populated. `affected_consumers` is a soft signal (informational);
 * `breaking_changes` is what `promoteDraft` blocks on; `warnings` is
 * extensible for future axes (Slice D ships with `warnings: []`).
 */
export async function analyzeImpact(
  db: NodePgDatabase<Record<string, never>>,
  tenantId: string,
  draftId: string,
): Promise<ImpactReport> {
  // 1. Fetch the draft.
  const draftResult = await db.execute<DraftRow>(sql`
    SELECT namespace, draft_json, schema_version
      FROM config_draft
      WHERE id = ${draftId} AND tenant_id = ${tenantId}
  `);
  if (draftResult.rows.length === 0) {
    throw new ImpactAnalysisDraftNotFoundError(draftId);
  }
  const draft = draftResult.rows[0]!;

  // 2. Strip tier prefix → logical namespace.
  const logicalNamespace = stripTierPrefix(draft.namespace);
  if (logicalNamespace === null) {
    // Non-prefixed literal namespace (e.g., 'foo'). No consumers
    // can be registered for this via registerConfigConsumer (which
    // requires logical namespace + dual-tier registration), so
    // there's nothing to analyze.
    return emptyReport();
  }

  // 3. Lookup impact-eligible consumers.
  const consumers = getImpactEligibleConsumers(logicalNamespace);
  if (consumers.length === 0) {
    return emptyReport();
  }

  // 4. Fetch current latest version's config_json.
  const currentResult = await db.execute<CurrentVersionRow>(sql`
    SELECT config_json
      FROM tenant_config_version
      WHERE tenant_id = ${tenantId} AND namespace = ${draft.namespace}
      ORDER BY version_number DESC
      LIMIT 1
  `);

  // 5. Schema-version drift detection (D.3, Q-NEW-F04D-2 axis 2a).
  // Runs in BOTH genesis case AND non-genesis case — drift can break
  // a consumer even on first promote (e.g., consumer pinned at v=N
  // but draft promotes at v=M with shape that fails v=N validation).
  const drift = detectSchemaIncompatibilities(draft.namespace, draft.draft_json, consumers);

  // 6. Genesis case — no current version. No data-axis breakage
  // possible (key_removed needs a "before" state). Surface only
  // schema-drift findings.
  if (currentResult.rows.length === 0) {
    return {
      affected_consumers: [],
      breaking_changes: drift.breaking,
      warnings: drift.warnings,
    };
  }
  const current = currentResult.rows[0]!;

  // 7. Compute structural diff (current → draft).
  const diff = diffJson(current.config_json, draft.draft_json);
  if (diff.length === 0) {
    // No-op promote (draft equals current). Schema-drift still applies
    // (someone may have re-registered the schema between draft-create
    // and promote even with no data change).
    return {
      affected_consumers: [],
      breaking_changes: drift.breaking,
      warnings: drift.warnings,
    };
  }

  // 8. For each consumer: intersect keyPaths against diff.
  const affected: AffectedConsumer[] = [];
  const breaking: BreakingChange[] = [...drift.breaking];

  for (const consumer of consumers) {
    // Type narrowing — getImpactEligibleConsumers only returns entries
    // where consumerModule is set, so we know it's a string here.
    const consumerModule = consumer.consumerModule!;
    const policy: BreakingChangePolicy = consumer.breakingChangePolicy ?? 'warn';
    const keyPaths = consumer.keyPaths;

    // Determine touched diff entries.
    const touchedDiffs: JsonDiffEntry[] =
      keyPaths === undefined || keyPaths.length === 0
        ? diff // namespace-level — every diff entry touches the consumer
        : diff.filter((d) => keyPaths.some((kp) => pathMatchesKeyPath(d.path, kp)));

    if (touchedDiffs.length === 0) continue;

    // Compute matched keyPaths (the registered keyPaths whose patterns
    // intersected at least one diff entry). Empty for namespace-level
    // consumers (their keyPaths is undefined/empty).
    const matchedKeyPaths =
      keyPaths === undefined || keyPaths.length === 0
        ? []
        : keyPaths.filter((kp) => touchedDiffs.some((d) => pathMatchesKeyPath(d.path, kp)));

    affected.push({
      consumer_module: consumerModule,
      namespace: logicalNamespace,
      matched_key_paths: matchedKeyPaths,
      policy,
    });

    // Breaking changes — key_removed.
    for (const d of touchedDiffs) {
      if (d.kind === 'removed') {
        breaking.push({
          kind: 'key_removed',
          consumer_module: consumerModule,
          detail: `key ${JSON.stringify(d.path)} removed; consumer ${JSON.stringify(consumerModule)} registered against namespace ${JSON.stringify(logicalNamespace)}.`,
        });
      }
    }

    // Breaking changes — policy_block.
    if (policy === 'block') {
      breaking.push({
        kind: 'policy_block',
        consumer_module: consumerModule,
        detail: `consumer ${JSON.stringify(consumerModule)} registered breakingChangePolicy='block' on namespace ${JSON.stringify(logicalNamespace)}; ${touchedDiffs.length} change(s) intersected its keyPaths.`,
      });
    }
  }

  return {
    affected_consumers: affected,
    breaking_changes: breaking,
    warnings: drift.warnings,
  };
}

function emptyReport(): ImpactReport {
  return { affected_consumers: [], breaking_changes: [], warnings: [] };
}

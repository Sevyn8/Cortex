/**
 * F04 Slice D — schema-version drift detection (Q-NEW-F04D-2 axis 2a).
 *
 * **The breakage shape:** consumer registered at `schemaVersion = N`;
 * a draft is being promoted with `schema_version = M`. The draft's
 * `draft_json` validates against schema v=M (validateDraft enforces
 * that at draft-time per Slice B). The question Slice D asks is: does
 * the draft's data ALSO validate against the CONSUMER's schema at
 * v=N? If not, the consumer's parser would throw on read — that's a
 * `schema_incompatible` breaking change.
 *
 * Both directions of version drift can produce breakage:
 *   - **M > N (forward drift):** schema bumped after consumer
 *     registered. New shape may add required fields the consumer's
 *     v=N schema doesn't expect.
 *   - **M < N (backward drift):** data is at an older shape than the
 *     consumer's pinned version. Consumer's v=N schema may require
 *     fields that don't exist in v=M data.
 *   - **M == N:** the data and consumer's schema are at the same
 *     version. Drift only happens if the schema was mutated in-place
 *     at v=N (per `### Schema-version mutation rule` in CLAUDE.md).
 *     We still parse; failing-to-parse means in-place mutation
 *     created an incompatibility.
 *
 * **Lookup tier.** Consumers register via `registerConfigConsumer`
 * for a logical namespace; that registers the schema under both
 * `tenant.<ns>` and `platform.<ns>` (identical reference). The draft's
 * `namespace` is one of those literal tier names. We look up the
 * schema at `(draft.namespace, consumer.schemaVersion)` — the same
 * tier as the draft, with the consumer's pinned version. Schemas at
 * both tiers are identical, so tier choice is cosmetic but matches
 * the draft for clarity.
 *
 * **Warnings vs breaking changes.** If the consumer's pinned schema
 * is not registered (e.g., consumer registered before the schema, or
 * the registry was reset), we emit a `Warning` rather than a
 * breaking change — it's a setup issue, not a data-breakage issue.
 *
 * Per Q-NEW-F04D-6: structural diff covers axis 1 (`key_removed`);
 * this helper covers axis 2a (`schema_incompatible`). Zod-semantic
 * schema-shape diff (deep comparison of two schema definitions)
 * remains DEFERRED to first-consumer-driven.
 */

import { getNamespaceSchema } from './schema-registry.js';
import type { ConsumerEntry } from './consumer-registry.js';
import type { BreakingChange, Warning } from './impact-analysis.js';

export interface SchemaDriftFindings {
  breaking: BreakingChange[];
  warnings: Warning[];
}

/**
 * Detect schema-version-drift breaking changes for a draft about to
 * promote against a set of impact-eligible consumers.
 *
 * For each consumer:
 *   - Look up the schema registered for `(literalNamespace, consumer.schemaVersion)`.
 *   - If the schema is not registered, emit a `Warning` (setup issue).
 *   - Else parse `draftJson` with that schema. If the parse fails,
 *     emit a `schema_incompatible` `BreakingChange` for the consumer.
 *
 * Pure function — does no I/O, no DB. Caller (analyzeImpact) merges
 * the returned arrays into the report.
 */
export function detectSchemaIncompatibilities(
  literalNamespace: string,
  draftJson: unknown,
  consumers: ConsumerEntry[],
): SchemaDriftFindings {
  const breaking: BreakingChange[] = [];
  const warnings: Warning[] = [];

  for (const consumer of consumers) {
    const consumerModule = consumer.consumerModule;
    if (consumerModule === undefined) continue; // defense in depth — caller filters this

    const consumerSchemaVersion = consumer.schemaVersion;
    const entry = getNamespaceSchema(literalNamespace, consumerSchemaVersion);
    if (entry === undefined) {
      warnings.push({
        kind: 'consumer_pinned_schema_not_registered',
        consumer_module: consumerModule,
        detail:
          `consumer ${JSON.stringify(consumerModule)} pinned at schemaVersion=${consumerSchemaVersion} for namespace ${JSON.stringify(literalNamespace)}, ` +
          `but no schema is registered at that (namespace, version). Setup issue: verify the consumer module's registerConfigConsumer call ran AND a schema is registered for the consumer's pinned version.`,
      });
      continue;
    }

    const result = entry.schema.safeParse(draftJson);
    if (!result.success) {
      breaking.push({
        kind: 'schema_incompatible',
        consumer_module: consumerModule,
        detail:
          `draft data fails consumer ${JSON.stringify(consumerModule)}'s pinned schema (v=${consumerSchemaVersion}) for namespace ${JSON.stringify(literalNamespace)}. ` +
          `Zod issues: ${formatZodIssueShortlist(result.error.issues)}`,
      });
    }
  }

  return { breaking, warnings };
}

function formatZodIssueShortlist(issues: { path: (string | number)[]; message: string }[]): string {
  if (issues.length === 0) return '(no issues)';
  const head = issues.slice(0, 3).map((iss) => {
    const path = iss.path.length === 0 ? '<root>' : iss.path.join('.');
    return `${path}: ${iss.message}`;
  });
  const tail = issues.length > 3 ? ` ... (+${issues.length - 3} more)` : '';
  return head.join('; ') + tail;
}

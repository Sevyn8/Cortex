# modules/artifact-registry

Creates N Docker repositories in Artifact Registry with CMEK encryption, cleanup policies, immutable tags, and parametric reader-member IAM.

Used by `environments/shared/` to provision the three Cortex image registries (`cortex-apps`, `cortex-agents`, `cortex-mcp`).

## Inputs

| Name             | Type                                         | Default         | Description                                                               |
| ---------------- | -------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| `project_id`     | `string`                                     | —               | Project to place repos in.                                                |
| `location`       | `string`                                     | `"asia-south1"` | AR region. Must match CMEK key location.                                  |
| `repositories`   | `list(object({repository_id, description}))` | —               | Repos to create. `repository_id` validated against `^cortex-[a-z0-9-]+$`. |
| `kms_key_id`     | `string`                                     | —               | CMEK key. All repos use the same key.                                     |
| `reader_members` | `list(string)`                               | `[]`            | IAM members granted `roles/artifactregistry.reader` on each repo.         |
| `immutable_tags` | `bool`                                       | `true`          | Prevent tag overwrites after push.                                        |
| `common_labels`  | `map(string)`                                | `{}`            | Labels applied to each repo.                                              |

## Outputs

| Name              | Description                                  |
| ----------------- | -------------------------------------------- |
| `repository_ids`  | Map of repo_id → full resource ID.           |
| `repository_urls` | Map of repo_id → docker-pullable URL prefix. |

## Cleanup policies (hardcoded)

1. **Keep** the 20 most-recent versions (any tag state) — rolling window for recent builds
2. **Keep** all versions tagged `dev`, `staging`, or `prod` (floating env tags)
3. **Keep** all versions tagged `v*` (semver releases — kept indefinitely)
4. **Delete** untagged images older than 90 days

Policies are hardcoded because they express platform-wide image-lifecycle policy, not per-repo policy. Change them only with an ADR.

**Prefix-match semantics:** Rules 2 and 3 use `tag_prefixes`, which is prefix match (not exact). By CLAUDE.md convention, Cortex floating tags are **exactly** `dev`, `staging`, `prod` — no variants like `dev-experimental` or `prod-backup`. That convention is what makes the prefix match effectively exact.

**Single-rule limitation:** A cleanup rule may use either `condition` OR `most_recent_versions`, not both (API-enforced). "Keep most-recent N per semver" is therefore not expressible as a single rule — rule 3 keeps all semver versions indefinitely, which is fine because semver releases are infrequent and small.

## Vulnerability scanning

Container Analysis is a project-level capability activated via `containeranalysis.googleapis.com`. Enablement happens in the caller's `project-baseline` module call, not here. Not controllable per-repository.

## Notes

- IAM is additive (`google_artifact_registry_repository_iam_member`, not `_binding` or `_policy`). Safe to re-apply.
- Cross-project reader grants are common: dev/staging/prod runtime SAs live in their env projects but need `reader` on shared repos. The `reader_members` input accepts any IAM member string (`serviceAccount:x@y.iam.gserviceaccount.com`, `group:g@org.com`).

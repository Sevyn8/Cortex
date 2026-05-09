# Branch protection enforcement — 2026-05-09 audit trail

> Captured 2026-05-09 in the same session that closed roadmap §4.20 (commit `888249d`) and Slice B test fixes (commit `a7c9a23`). The branch-protection change is the structural fix for the bypass that masked D.6 + Slice B bugs across multiple slices.

## Why

Three pushes in a 24-hour window landed on `main` with red CI:

| Commit    | Subject                                                                              | CI conclusion                                                                                                     |
| --------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `0b7a6b1` | `feat(F02-D.6): convention §7 finalize + d.4.5 deferrals + slice d close`            | failure                                                                                                           |
| `de84fb4` | `feat(F03-B): temporal-query lib + @cortex/test-db-harness extraction`               | failure                                                                                                           |
| `888249d` | `fix(p1.3-x): §4.20 local DB test capability — docker-compose realigned to CI shape` | failure (expected — fixed pre-existing red baseline; the §4.20 fix didn't itself address Slice B's failing tests) |

In every case, the push surfaced GitHub's `remote: Bypassed rule violations for refs/heads/main: - Required status check "Run foundation tests against ephemeral Postgres" is expected.` warning. The required check was configured but **not enforced** because `enforce_admins=false`. Owners (rahul-1974, amitboni) bypassed the gate on every direct push.

Per the §4.20 root-cause analysis: the D.6 bug shipped to main red and stayed red across 3 slices because (a) local tests couldn't run due to §4.20 (closed in `888249d`), AND (b) admin-bypass let the red commits through anyway. Closing one without the other left the loop open.

This commit applies GitHub's branch-protection Candidate 1 (`required_approving_review_count=0`) — PR-required, CI-gated, no human review needed. Documented in the GitHub OpenAPI schema as the canonical solo-maintainer / 2-seat pattern: _"Use a number between 1 and 6 or 0 to not require reviewers."_

## Before-state — 2026-05-09 pre-PUT

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Run foundation tests against ephemeral Postgres"]
  },
  "required_signatures": { "enabled": false },
  "enforce_admins": { "enabled": false },
  "required_linear_history": { "enabled": false },
  "allow_force_pushes": { "enabled": false },
  "allow_deletions": { "enabled": false },
  "block_creations": { "enabled": false },
  "required_conversation_resolution": { "enabled": false },
  "lock_branch": { "enabled": false },
  "allow_fork_syncing": { "enabled": false }
}
```

`required_pull_request_reviews` was absent (no PR requirement). `enforce_admins.enabled = false` (the bypass).

## After-state — 2026-05-09 post-PUT

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Run foundation tests against ephemeral Postgres"]
  },
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false,
    "required_approving_review_count": 0
  },
  "required_signatures": { "enabled": false },
  "enforce_admins": { "enabled": true },
  "required_linear_history": { "enabled": false },
  "allow_force_pushes": { "enabled": false },
  "allow_deletions": { "enabled": false },
  "block_creations": { "enabled": false },
  "required_conversation_resolution": { "enabled": false },
  "lock_branch": { "enabled": false },
  "allow_fork_syncing": { "enabled": false }
}
```

## Diff summary — three changed fields

1. **`enforce_admins.enabled`**: `false` → `true`. Owners no longer bypass any rule.
2. **`required_pull_request_reviews`**: absent → `{ required_approving_review_count: 0, dismiss_stale_reviews: false, require_code_owner_reviews: false }`. PRs are now mandatory; zero approvals required (CI is the gate).
3. **`require_last_push_approval`**: absent → `false` (defaulted by the API; not material).

All other fields unchanged.

## Verification — direct push must be rejected

```bash
$ git checkout main
$ echo "" >> docs/future-roadmap.md
$ git commit -am "test: branch protection verification (will revert)"
$ git push origin main
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
remote: - Required status check "Run foundation tests against ephemeral Postgres" is expected.
 ! [remote rejected] main -> main (protected branch hook declined)
$ git reset --hard HEAD~1
```

Direct push **rejected** as expected. The verification commit was reverted; `main` HEAD is still `a7c9a23`.

## Inaugural-PR pattern

The PR landing this audit-trail file is the **first PR ever merged via the new policy**. It bundles four atomic commits (branch-protection apply + CLAUDE.md workflow doc + Slice B docs(progress) + Slice B.5 scope) so the branch-protection change is exercised end-to-end before any single-commit chore lands.

Per CLAUDE.md `## Branching & PR` (replaced in commit 2 of this PR), every future commit to main goes via PR + CI green. The §4.20 closure (`888249d`) and Step 2 fix (`a7c9a23`) were the **last commits to land on main via direct push**.

## References

- §4.20 closure (commit `888249d`) — local DB test capability; the other half of this fix
- Step 2 commit (`a7c9a23`) — Slice B test fixes; previewed the bypass-on-push warning that prompted this investigation
- D.6 commit (`0b7a6b1`) — primary motivating incident; red CI carried for 3 slices
- GitHub REST API schema — `required_approving_review_count` value 0 documented as "do not require reviewers"
- CLAUDE.md `## Branching & PR` — workflow documented in this PR's commit 2

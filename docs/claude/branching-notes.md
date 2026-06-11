# Branching notes - why no admin bypass, solo-dev review posture

> Relocated from CLAUDE.md for context-budget; loaded on demand.

### Why no admin bypass

Carried red CI on D.6 for 3 slices. The bypass was structural, not procedural - `enforce_admins` was `false`. Closed 2026-05-09 along with §4.20. See `docs/planning/branch-protection-2026-05-09.md` for the audit trail.

### Solo-dev review note

GitHub's PR-author-cannot-approve rule means human review would block on a second seat. Configuration deliberately requires NO human review (`required_approving_review_count: 0`) - CI is sufficient. Two-person review remains a social convention for high-stakes changes (architectural pivots, schema migrations affecting prod data, security-sensitive code). Operator's judgment.

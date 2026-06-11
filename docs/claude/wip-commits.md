# WIP commits

> Relocated from CLAUDE.md for context-budget; loaded on demand.

When a slice breaks across sessions, stage progress as a WIP commit on the slice branch (do not push). The WIP commit squashes away at HOLD #3 squash composition.

Commit shape: `chore(<scope>): wip <description>`

- Type MUST be one of the commitlint-allowed types (`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ops` / `perf` / `style` / `build` / `ci` / `revert`). `wip` is NOT an allowed type and will be rejected by commitlint with `type-enum`.
- Subject body MUST be lowercase even for module IDs (`D.1-D.4` fails `subject-case`; `d.1-d.4` passes).
- Body documents the WIP state (what's done, what's pending, self-verify status — pre-existing-tests passing, typecheck clean, etc.).
- DO NOT push the WIP commit; it lives on the local slice branch only and squashes into the final `feat(...)` at HOLD #3 composition.

Example:

```
chore(f04-d): wip d.1-d.4 impact analysis substrate + lifecycle wiring

Mid-build WIP commit at HOLD #2 per operator session-break.
Will be squashed into the final feat(F04-D) commit at HOLD #3
composition. Working tree state is verifiable:
  - 89/89 config-plane tests passing
  - typecheck across 30 packages clean
  ...
```

Lesson surfaced PR #N (Slice D HOLD #2): operator's draft used `wip(...)` as the type and uppercase `D.1-D.4` in the subject — both rejected by commitlint. The fix retained body verbatim with type=`chore` + lowercase subject.

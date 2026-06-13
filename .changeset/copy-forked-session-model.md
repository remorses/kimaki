---
'kimaki': patch
---

Keep forked Discord sessions on the same model as the source session.

When `/btw` forks a side-question thread or `/new-worktree` creates a worktree from an existing thread, Kimaki now snapshots the effective source model onto the new OpenCode session before sending prompts there.

---
'kimaki': minor
---

Expose worktree merging as the root `kimaki merge-worktree` CLI command.

```sh
kimaki merge-worktree --strategy squash --target-branch main
```

When `/merge-worktree` starts agent-assisted rebase conflict resolution, the agent now runs this command itself after resolving every conflict. A successful retry also clears the worktree marker from the Discord thread title. If the target changed and the retry cannot finish, it reports the failure so the user can retry later.

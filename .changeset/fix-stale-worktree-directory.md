---
'kimaki': patch
---

Fix "Worktree creation failed" error when auto-derived worktree names collide with existing worktrees.

`createWorktreeInBackground` now checks `git worktree list` before attempting creation, so auto-worktrees (from first-time messages) and `--worktree` sessions correctly detect and surface the collision instead of failing with a confusing error.

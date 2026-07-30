---
'kimaki': patch
---

Fix automatic worktree creation failing with `fatal: a branch named 'opencode/kimaki-...' already exists` when the generated branch name collides with an existing branch in the repository.

`createWorktreeCore` now checks `git rev-parse --verify refs/heads/<branchName>` before invoking `git worktree add`. On collision it picks a fresh branch name — first by appending a short predictable suffix (`-2`, `-3`, ...), falling back to a random unique string — and continues with the worktree creation transparently. The user no longer sees the raw git error and the worktree creates successfully on a new branch.

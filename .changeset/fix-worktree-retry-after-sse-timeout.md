---
'kimaki': patch
---

Fix worktrees stuck in an error state after an `WorkspaceCreateError: Timed out waiting for global event` race condition.

Previously a worktree creation that timed out waiting for the OpenCode global event would leave the thread in a permanent error state — sending a new message would just echo the stale error. Two fixes:

1. **SDK retry on timeout**: `tryWorkspaceCreate` now reconnects the global SSE event listener and waits for it to come back online before retrying `workspace.create` once. This resolves the underlying timeout race when the SDK call fires before the subscription is established.
2. **Auto-retry on user reply**: Threads with a worktree in `error` state now automatically retry worktree creation when the user sends a new message, instead of echoing the stale error from the database.
3. **Recover orphan branches**: If the previous attempt created the git branch and worktree directory but timed out before the OpenCode SDK recorded the workspace, retry now detects the "branch already exists" response and reuses the existing worktree directory instead of failing again.

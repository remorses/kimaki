---
'kimaki': patch
---

Parallelize independent async operations in `/btw` and `/new-worktree` commands to reduce latency.

**`/btw`**: session lookup, opencode init, and parent channel resolve now run concurrently. Member add and status message send are also parallelized after DB mapping completes.

**`/new-worktree`**: base branch validation, existing worktree check, and parent channel resolve now run concurrently. Thread member add and status message send are parallelized. The deferred reply edit is fire-and-forget so it doesn't block background worktree creation.

Lifecycle-critical operations (session fork before thread creation, DB mapping before visibility, pending DB row before git) remain sequential for correctness.

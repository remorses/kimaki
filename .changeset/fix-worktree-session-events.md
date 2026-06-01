---
'kimaki': patch
---

Change `/new-worktree` in an existing Discord thread to create a separate worktree thread instead of switching the current thread in-place.

The original thread stays bound to its existing checkout and session. The new thread gets the worktree, the forked session context, and the worktree metadata used by `/merge-worktree`.

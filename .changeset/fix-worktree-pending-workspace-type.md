---
"kimaki": patch
---

Fix `/worktree` command creating the pending workspace row with `undefined` workspace type.

`createWorktreeInBackground` previously referenced a `workspaceType` variable that was scoped to `tryWorkspaceCreate` and therefore always undefined at the call site. The pending row was written with `workspace_type = NULL`, which could cause downstream code paths to misread the workspace state before the actual worktree was created. The pending row now correctly stores `'kimaki-worktree'`.

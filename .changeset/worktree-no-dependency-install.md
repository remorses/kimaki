---
'kimaki': patch
---

New worktrees no longer install dependencies, so `/new-worktree`, `kimaki send --worktree` and automatic worktrees start much faster and a failed install no longer blocks the session. Submodules are still initialized. Sessions that run in a worktree get a short instruction to install dependencies and build what is needed before they run scripts, builds or tests.

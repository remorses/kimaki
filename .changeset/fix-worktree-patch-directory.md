---
'kimaki': patch
---

Fix forked worktree sessions running file tools against the source checkout.

Kimaki now includes the created OpenCode workspace ID when it forks an existing session into a worktree. This makes `apply_patch`, file reads, edits, writes, and terminal commands consistently use the worktree directory instead of splitting operations across two checkouts.

---
'kimaki': patch
---

Clear the worktree marker from a thread title when `/merge-worktree` finds no commits to merge.

This keeps already-up-to-date worktree threads from staying marked as unmerged after Kimaki reports `Merge failed: No commits to merge -- branch is already up to date with main`.

---
'kimaki': patch
---

Show git command, exit code, and stderr when `/merge-worktree` fails.

Before, a failed local fast-forward only showed `Merge failed: Push to main failed` with no git output. The command reply now includes the command that failed, the exit code, and git stderr so hook rejections, checked-out branch refusals, and permission errors are visible.

This is a local update of the target branch, not a push to origin. After a push failure the worktree rebase is kept and the target branch is left unchanged.

---
'kimaki': minor
---

Add a merge strategy select to `/merge-worktree` with **Keep commits (rebase)** and **Squash into one commit** choices.

Keeping commits remains the default. Squash mode first rebases the worktree onto the target so the existing agent-assisted conflict flow still works, then adds the complete result to the target as one commit.

```text
/merge-worktree strategy:Squash into one commit target-branch:main
```

The completion message reports how many source commits were squashed.

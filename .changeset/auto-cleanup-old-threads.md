---
'kimaki': minor
---

Add daily thread cleanup sweeper that prompts to archive stale sessions.

Merged worktree threads get a message with "Clean up worktree & archive" / "Dismiss" buttons.
Non-worktree threads older than 2 days get a message with "Archive thread" / "Dismiss" buttons.
Cleanup only happens when the user clicks the confirmation button.

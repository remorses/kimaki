---
'kimaki': patch
---

Fix `/new-worktree` in an existing thread so the next message starts a fresh OpenCode session in the new worktree checkout.

This prevents follow-up messages from reusing the old checkout session after the thread switches directories.

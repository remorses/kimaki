---
'kimaki': patch
---

<!-- Prevent worktree messages from starting a replacement session during setup. -->

Keep `/new-worktree` sessions on the source model when a message arrives as soon as the checkout is ready.

Kimaki now binds the forked OpenCode session, model, and permissions before marking the worktree ready. This prevents an early message from racing setup and starting a fresh session with the channel's default agent or model.

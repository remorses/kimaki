---
'kimaki': patch
---

Dismiss stale permission buttons in Discord when a plugin auto-rejects permissions.

When the `subagent-rate-limit-plugin` (or any other plugin) replies to a permission request via `client.permission.reply()`, the corresponding Discord message now updates to show the rejection status and removes the interactive buttons. Previously, the buttons stayed active even though the permission was already handled, confusing users.

---
'kimaki': patch
---

Fix `sendMessage` failing with a Discord 400 error when rendering long markdown tables.

Tables with many rows and long cell values (for example `/worktrees` or `/tasks` output with long paths) could stay under Discord's 40-component budget while still exceeding the 4000-character total text limit for Components V2 messages. That combination silently failed to send.

Table rows are now chunked by both the component count budget and the text size budget, splitting large tables across multiple messages when needed. A single row whose own content exceeds 4000 characters is also clamped instead of being sent as-is.

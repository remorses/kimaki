---
'kimaki-cli2': patch
---

Fix shutdown, scheduled-task edits, and reconnect handling in the V2 rebuild.

- Wait for the same cleanup promise when shutdown signals arrive together, so the process does not exit before cleanup finishes.
- Verify plugin activation on the current OpenCode connection instead of caching an old connection's result after reconnect.
- Preserve empty strings and permission arrays when editing scheduled tasks. Keep execution defaults unchanged.
- Close the queue acknowledgement when reconnect discovers that an item was promoted to steer, without sending an echo.

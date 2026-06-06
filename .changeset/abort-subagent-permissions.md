---
'kimaki': patch
---

Abort task subagents after auto-rejecting a permission request.

Task subagents do not support interactive permission approval, so Kimaki rejects their permission requests and aborts the child session immediately. After aborting, Kimaki sends the child session a short instruction explaining that the permission was denied, to avoid retrying the same blocked tool call, and to either continue another way or summarize what is blocked while OpenCode's task permission denial behavior is still being fixed upstream.

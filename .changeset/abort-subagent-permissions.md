---
'kimaki': patch
---

Abort task subagents after auto-rejecting a permission request.

Task subagents do not support interactive permission approval, so Kimaki rejects their permission requests and aborts the child session immediately. This prevents denied tool calls from producing repeated permission requests while OpenCode's task permission denial behavior is still being fixed upstream.

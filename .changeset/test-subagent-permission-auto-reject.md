---
'kimaki': patch
---

Auto-reject permission requests in task subagent sessions.

Task subagents do not support interactive permission approval. OpenCode's `continue_loop_on_deny` only works in the main agent loop, not in tasks. The subagent plugin now watches for `permission.asked` events on tracked subagent sessions and immediately rejects them so the task fails fast instead of hanging for the full permission timeout. Also fixes tracking of child sessions created before the parent task tool reports `metadata.sessionId`.

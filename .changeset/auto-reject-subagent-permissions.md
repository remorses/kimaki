---
'kimaki': patch
---

Auto-reject permission requests in task/subagent sessions.

OpenCode's `continue_loop_on_deny` only works in the main agent loop, not in tasks.
Task permissions use `Effect.orDie` which turns rejections into fatal crashes
(see https://github.com/anomalyco/opencode/issues/31108). As a workaround, the
subagent plugin now watches for `permission.updated` events on tracked subagent
sessions and immediately rejects them so the task fails fast and returns to the
parent, rather than hanging for the full permission timeout.

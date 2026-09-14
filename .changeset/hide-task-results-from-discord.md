---
'kimaki': patch
---

Keep delegated task results out of Discord session output.

Background OpenCode sync now ignores child sessions by their parent session ID. Discord still shows the task start and configured tool activity, but no longer posts the subagent's full internal response into the parent thread.

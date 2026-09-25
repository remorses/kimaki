---
'kimaki': patch
---

Fix misleading `task-1` prefixes on subagent tool calls when a child session starts before its parent task metadata arrives. Show the agent name and the task's correct number once the task call identifies the child. Preserve the agent name if a later task update omits it.

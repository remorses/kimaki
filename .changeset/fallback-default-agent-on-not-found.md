---
'kimaki': patch
---

Fall back to default agent instead of throwing when a requested agent is not found.

Previously, if `kimaki send --agent foo` referenced an agent that didn't exist in the
project's opencode config, the session would fail with an error. Now it logs a warning
and uses the default agent, which is more resilient to stale agent preferences or
removed agents.

Closes #136

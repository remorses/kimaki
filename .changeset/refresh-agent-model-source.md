---
'kimaki': patch
---

Refresh the agent model when you run `/agent` or `/xxx-agent` even if that agent is already selected.

This matters when the agent file changed, or when a leftover thread `/model` override is still pinned. The command now clears the session model copy and shows which model will be used next, plus **why**:

```
Using **plan** agent for this session
Model: *anthropic/claude-sonnet-4* (agent "plan")
The agent will change on the next message.
```

If a **session** or **channel** `/model` override is the reason that model is selected, the reply tells you to run `/model` and press **Clear override** so the agent's own model can apply.

`/model` on this thread still beats the agent model. The agent's model still beats a channel or global `/model`.

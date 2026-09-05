---
'kimaki': patch
---

Keep Discord arrival order for agent and model preference writes with follow-up messages.

`/plan-agent` then an immediate text no longer races the previous agent. The follow-up waits until the agent switch is stored, then starts with the new agent.

Prompts already go through OpenCode (`/plan-agent hello`, `/compact`). Those are not held on this queue.

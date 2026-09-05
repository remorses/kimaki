---
'kimaki': patch
---

Keep Discord arrival order for one-shot agent and command slash calls with follow-up messages.

`/plan-agent` then an immediate text no longer races the previous agent. The follow-up waits until the agent switch is stored, then starts with the new agent.

The same order applies to one-shot `/foo-cmd` and `/foo-skill`. `/model`, `/agent`, and `/compact` are not held on this queue.

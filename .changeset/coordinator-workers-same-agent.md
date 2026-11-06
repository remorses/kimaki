---
'kimaki': patch
---

The coordinator now starts workers with its own agent, so they run on the same model as the coordinator. It no longer picks a stronger or cheaper agent by task difficulty. Forks (`. btw`) and follow-ups keep the agent and model of their thread. A different agent or model is used only when you name one.

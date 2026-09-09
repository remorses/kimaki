---
'kimaki': patch
---

Match OpenCode v2 agent names without case sensitivity, and pass the agent id to `session.switchAgent`.

v2 built-in agents are named `Plan`, `Build`, and so on. `/plan-agent` still works, and the agent's configured model is used instead of falling back to the default.

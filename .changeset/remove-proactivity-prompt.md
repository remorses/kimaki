---
'kimaki': patch
---

Remove the proactivity rules from the Kimaki system prompt. Agents are no longer told "Be proactive... Do NOT stop to ask for confirmation" or "Do the work first, then offer follow-ups". This makes it easier to explore different approaches and get root cause analysis before the agent implements a fix. Your own `AGENTS.md` or opencode instructions now decide how eager the agent is.

The rules for the `question` tool (write text first, call `question` last, never a plain numbered list) stay.

Fixes #230

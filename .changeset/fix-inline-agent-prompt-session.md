---
'kimaki': patch
---

Fix quick agent slash commands with inline prompts so the session actually switches to the selected agent.

Using `/plan-agent <prompt>` now starts or continues the Discord thread with the `plan` agent instead of only borrowing that agent's model while OpenCode still runs the previous `build` agent.

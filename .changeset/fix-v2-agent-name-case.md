---
'kimaki': patch
---

Fix agent selection so it also selects the agent's configured model and thinking level, matching OpenCode V2's TUI.

OpenCode exposes separate agent and model switches. Selecting `/opus-agent` or an agent from `/agent` now replaces a stale session model with that agent's configured model. This also applies to agent prompts and voice input.

Agent shortcuts use the selected agent's model for thinking-level autocomplete. An explicit `variant:` overrides its configured thinking level. Channel agent changes save both defaults for new sessions, while later explicit model or thinking-level choices remain in effect.

Match agent names without case sensitivity and pass their IDs to OpenCode. Built-in names such as `Plan` and `Build` still work through `/plan-agent` and `/build-agent`.

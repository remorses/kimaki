---
'kimaki': patch
---

Fix random `Agent opus is not available in this project` errors when a saved channel agent comes from `~/.config/opencode/agent/*.md` or a plugin.

OpenCode evicts idle projects. The next message boots the project again, and for a short time `agent.list` only returns built-in agents. Kimaki now waits for OpenCode plugin activation before it reads the agent, command and skill lists. This also stops slash command shortcuts from briefly losing agents after the project boots again.

OpenCode issue: https://github.com/anomalyco/opencode/issues/51282

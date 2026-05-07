---
'kimaki': patch
---

Clarify the system prompt guidance for starting Kimaki sessions from the CLI.

Agents are now told to use the current channel by default, only target another project channel or checkout path when the user explicitly asks, and only create worktrees when the user explicitly asks for one.

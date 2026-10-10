---
'kimaki': patch
---

Show messages sent to a session from outside Discord in its thread. When you continue a Kimaki session from the OpenCode TUI, the phone app or another client, the thread now shows your message before the reply, like Kimaki V1 did:

```
» **user:** Back in the TUI, now fix the tests
```

Before, only the answer appeared, with no prompt above it. Inputs that Kimaki or OpenCode add by themselves stay hidden: synthetic messages (git branch notes, background shell results, subagent results), the expanded template of OpenCode commands run from Discord (`/review`, `/<cmd>-cmd`), and subagent prompts.

A queued OpenCode command (`/queue-command`, `/cmd args. queue`) now shows the command you typed when it starts, `» **tommy:** /review auth`, instead of `» **queued:**` with the expanded template.

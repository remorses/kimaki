---
'kimaki': patch
---

Threads started with `/new-session` and no prompt now get a real title. They were stuck on `Kimaki session`, because the agent was told OpenCode auto-titles the first turn; now it renames the thread on its first turn when the title is still that placeholder.

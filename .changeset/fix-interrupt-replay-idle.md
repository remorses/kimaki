---
'kimaki': patch
---

Fix Discord replies for messages that interrupt a long-running OpenCode tool call.

Kimaki now waits for OpenCode's post-abort idle event before replaying the interrupting user message, so the replay is not queued behind the cancelled run and its assistant response is visible in Discord.

Fixes #133

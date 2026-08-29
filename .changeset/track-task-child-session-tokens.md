---
'kimaki': patch
---

Count **task child session tokens** in Strada `tokens_used` events, not only the parent session.

Subagent runs from the `task` tool have their own OpenCode session and billed token snapshot (`Session.tokens` / assistant `message.updated`). Kimaki now emits those on child idle, and the parent idle still reports any child delta that never idled, without double-counting.

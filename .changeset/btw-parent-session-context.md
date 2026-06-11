---
'kimaki': patch
---

Pass parent session ID into btw-forked sessions so the agent can send messages back to the parent session using `kimaki send --session <parent_id>`.

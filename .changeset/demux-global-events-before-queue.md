---
'kimaki': patch
---

Prevent active OpenCode sessions from blocking unrelated Discord threads.

Global OpenCode events are now filtered by session before entering each
thread's serialized action queue. Previously, every event from every active
session was queued and buffered by every thread runtime, allowing a busy
session to create a growing backlog that stopped other threads from replying
while their typing indicators remained active.

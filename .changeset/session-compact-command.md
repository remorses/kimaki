---
'kimaki': minor
---

Add `kimaki session compact [id]`, so agents can compact a session themselves, like `/compact` in Discord.

```bash
kimaki session compact              # compact the calling session
kimaki session compact <thread ID>  # compact another thread's session
```

The compaction is queued: it runs after the current turn ends, so an agent that compacts its own session finishes its reply first. The system prompt tells agents about the command.

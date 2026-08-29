---
'kimaki': minor
---

Add `kimaki session title` so the agent can update the OpenCode session title and the Discord thread name when the session scope or goal changes.

```bash
kimaki session title 'Fix queue draining' --session ses_xxx
```

The current Discord thread title is now included in per-turn `<discord-user thread-name="..." />` metadata, so the agent can tell when the name is stale.

Discord thread rename is raced against a 3 second timeout so rate limits cannot hang the command.

---
'kimaki': minor
---

Add `kimaki session title` so the agent can update the OpenCode session title when the session scope or goal changes.

```bash
kimaki session title 'Fix queue draining' --session ses_xxx
```

Discord thread name follows from the OpenCode title. The current Discord thread title is included in per-turn `<discord-user thread-name="..." />` metadata so the agent can tell when the name is stale.

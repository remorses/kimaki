---
'kimaki': minor
---

`kimaki session read` now accepts a Discord thread ID in place of a session ID.

```bash
kimaki session read 1554429528670076959 > ./tmp/session.md
```

IDs that do not start with `ses` are treated as thread IDs. Agents now use this to read the session behind a Discord thread link the user shares.

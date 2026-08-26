---
'kimaki': minor
---

<!-- Release notes for active session discovery and polling. -->

Add active session filtering so agents can coordinate parallel work from the CLI.

```bash
kimaki session list --active
while kimaki session list --active --exclude "$CURRENT_SESSION_ID"; do sleep 5; done
```

`--active` includes each in-progress session's status and exits with status 1 when no matching sessions remain. Use `--exclude <sessionId>` to keep the current session out of polling loops.

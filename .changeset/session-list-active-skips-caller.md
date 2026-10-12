---
'kimaki': patch
---

`kimaki session list --active` never lists the calling session. Inside an agent shell it skips `OPENCODE_SESSION_ID`, so a wait loop no longer waits for itself and needs no `--exclude`. This also works for other projects and `--all`:

```bash
until kimaki session list --active --project /path/to/other-project; [ $? -eq 1 ]; do sleep 5; done
```

---
'kimaki': minor
---

Make `kimaki session search` faster by scanning only recent sessions by default.

The command now searches sessions updated in the **last 14 days**. Pass `--days 0` to search all time, or another number to change the window:

```bash
kimaki session search "auth timeout"
kimaki session search "auth timeout" --days 0
kimaki session search "auth timeout" --all --days 7
```

Text output prints each hit as soon as it is found. `--json` still prints one object at the end, including the `days` field used for the scan.

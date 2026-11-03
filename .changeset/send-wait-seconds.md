---
'kimaki': minor
---

`kimaki send --wait` now takes an optional number of seconds. `--wait 5` waits at most 5 seconds for the run, then prints the session as before, or a short line when it is still going:

```bash
kimaki send --thread <thread_id> --prompt 'Did the tests pass?' --wait 5
# run done in time: prints the session, like --wait
# still running: === ses_abc is still running after 5s. Run kimaki session wait ses_abc to wait for the rest ===
```

Bare `--wait` waits up to 1 day, so it works like before.

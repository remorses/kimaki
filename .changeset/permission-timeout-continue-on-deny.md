---
'kimaki': minor
---

Add configurable permission timeout and enable model continuation after permission denial.

**Permission timeout** (`--permission-timeout-minutes <minutes>`): configures how long
permission buttons stay active in Discord before auto-rejecting. Defaults to 10 minutes.

```bash
kimaki --permission-timeout-minutes 30
```

**Continue on deny**: the opencode config now sets `experimental.continue_loop_on_deny: true`,
so when a permission times out or the user clicks Deny, the model sees it as a tool error
and continues working (tries alternatives or explains it couldn't proceed) instead of the
session going dead silent. Previously, a denied permission would stop the entire agent loop.

Closes #140

---
'kimaki': minor
---

Add `--question-timeout-minutes` so AskUserQuestion dropdowns can stay open longer than the default 10 minutes.

Pending question dropdowns used a hardcoded 10-minute TTL. After that, Kimaki dropped the prompt **and aborted the OpenCode session**. Coming back later meant dead dropdowns and a new turn per thread.

This matches `--permission-timeout-minutes`:

```bash
kimaki --question-timeout-minutes 60
```

Default stays **10 minutes**. The value must be a positive whole number of minutes, capped at Node's `setTimeout` limit.

Fixes #192

---
'kimaki-cli2': patch
---

Show a notice in the thread when the provider prompt cache misses.

```
-# ⬦ prompt cache miss: 0 of 85k tokens cached, 12m 3s after the last request
```

It shows when a request reads fewer cached tokens than the previous request left in cache, for example after the cache expired (about 5 minutes idle on Anthropic), after a model switch, or when something changed the start of the prompt. Compaction resets the check.

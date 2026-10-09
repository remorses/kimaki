---
'kimaki': patch
---

Show background shell commands in the thread, and post a line when they finish.

```
-# ┣ shell _Run sleep 100 in background_ (background)
-# ⬦ background shell finished: _Run sleep 100 in background_
```

A shell call with `background: true` now always shows at the default verbosity, even without side effects. When OpenCode tells the agent the job ended, the thread gets a finished line, with the state or exit code when it did not succeed.

---
'kimaki': patch
---

Report a Kimaki OpenCode plugin that fails to load after it was already active.

The bot checked that the plugin was active only on the first message of each project. When OpenCode reloaded the plugin later and the load failed (for example while `pnpm build` or an npm upgrade rewrites the plugin files), sessions kept running without it: no Discord user context, and `kimaki buttons` or `kimaki upload-request` failed with an unclear error. OpenCode 2.2.5 keeps such a failed load until the service restarts.

Kimaki now checks the plugin on every message and shows the load error with the fix in Discord:

```
Kimaki plugin failed to load in OpenCode (err_9178be1f); ... run `opencode service restart`
```

`kimaki buttons` and `kimaki upload-request` also say that the plugin did not run, instead of asking for `KIMAKI_TOOL_CALL`.

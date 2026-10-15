---
'@kimaki/plugin-fallback': minor
---

Switch accounts, not only models. On a rate limit, quota, overload or auth error the plugin now moves to your next saved account of the same provider before it falls back to the next model.

```
429 on opus (account 1) ──▶ opus (account 2) ──▶ 429 ──▶ gpt-6-sol ──▶ turn finishes
```

The plugin calls `ctx.credential.activate`, added in OpenCode 2.0.28. The peer dependency is now `@opencode/plugin >= 2.0.28`. Update OpenCode to 2.0.28 or newer before you update the plugin.

Add a second account with `opencode auth login anthropic`. The account switch is global for that provider: a blocked account is not used by any session until its reset time.

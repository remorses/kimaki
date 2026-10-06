---
'@kimaki/plugin-fallback': minor
---

Add `@kimaki/plugin-fallback`, an OpenCode V2 plugin that keeps sessions running through rate limits, usage limits and overloaded providers.

```jsonc
{
  "plugins": [
    {
      "package": "@kimaki/plugin-fallback",
      "options": {
        "models": ["anthropic/claude-opus-5-5", "openai/gpt-6-sol#high", "xai/grok-4.6"]
      }
    }
  ]
}
```

When a model request fails with a rate limit, quota, overload or auth error, the plugin:

1. records a block with the exact reset time (`retry-after`, `anthropic-ratelimit-unified-reset`, Codex `resets_at` / `x-codex-*-reset-at`, `x-ratelimit-reset-*`)
2. picks the best ranked (model, account) pair that is not blocked: same model on your next account first, then the next model
3. activates that account, switches the session model, and retries the same step with no abort and no replay

```
429 on opus (account 1) ──▶ opus (account 2) ──▶ 429 ──▶ gpt-6-sol ──▶ turn finishes
```

- Accounts come from normal OpenCode logins. Run `opencode auth login anthropic` again to add a second account.
- Model changes are per session. A session never moves back up on its own, so its prompt cache stays warm.
- Blocks live in OpenCode plugin storage and are shared by every project on the server.
- When every pair is blocked, the session waits until the first one resets.
- `client.rpc(FallbackRpc).blocks({})` lists active blocks; `rpc.fallback.switched` events report every switch.

Switching accounts needs `ctx.integration.connection.activate` from OpenCode (anomalyco/opencode#52797). Older OpenCode versions only switch models.

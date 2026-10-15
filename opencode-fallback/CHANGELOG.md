# Changelog

## 0.2.0

1. **Switches accounts, not only models.** On a rate limit, quota, overload or auth error the plugin now moves to your next saved account of the same provider before it falls back to the next model.

   ```
   429 on opus (account 1) ──▶ opus (account 2) ──▶ 429 ──▶ gpt-6-sol ──▶ turn finishes
   ```

   Add a second account with `opencode auth login anthropic`. The account switch is global for that provider: a blocked account is not used by any session until its reset time.

2. **Requires OpenCode 2.0.28 or newer.** The plugin calls `ctx.credential.activate`, added in 2.0.28. The peer dependency is now `@opencode/plugin >= 2.0.28`. Update OpenCode before you update the plugin.

## 0.1.0

1. **New OpenCode 2 plugin that keeps sessions running through rate limits, usage limits and overloaded providers.**

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

# Changelog

## 0.3.0

1. **Tells the agent when fallback moves its session to another model.** The new model gets a system note with the old model, the new model and the reason, starting with the retried request:

   ```
   <model-fallback>
   This session ran on google/gemini-3.8-flash. The fallback plugin moved it to anthropic/claude-opus-5-5, the model you are now, because a request to the previous model failed: its login failed (expired or invalid credentials).
   Tools, input types (audio, video, images) and other abilities that google/gemini-3.8-flash had may be missing on this model. Earlier messages may assume them.
   If the task needs an ability you do not have, tell the user plainly. Never claim you used a tool, heard audio or saw content that you cannot access.
   </model-fallback>
   ```

   Before, the agent did not know about the switch: a Gemini agent used for audio input was moved to Claude, which then claimed it had heard the audio. The switch is stored in the session metadata (`fallback` key), so the note survives restarts and compaction. It goes away when you switch the session to another model by hand.

2. **Skips saved accounts whose login can no longer refresh.** Before switching to another account, fallback refreshes its token if needed. When the refresh fails (for example `invalid_grant: Refresh token expired` on an old Claude Pro/Max login), that account is blocked for 24 hours and the next account or model is tried in the same turn. Before, the session could end with `Claude Pro/Max login failed: token endpoint returned 400`.

   A refresh that fails on the account that is already active still ends the turn: OpenCode 2.2.5 fails there before plugins can react. That case needs https://github.com/anomalyco/opencode/pull/61757.

## 0.2.1

1. **Newer models in the default fallback ranking:** `openai/gpt-6.1-sol`, `xai/grok-4.7`, then `opencode-go/kimi-k3`. Copilot now falls back to `github-copilot/gpt-6.1-sol`. Set `options.models` to use your own ranking.

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

---
'kimaki': patch
---

Fix gateway onboarding flow silently failing, leaving CLI stuck on "Still waiting..." after the user authorizes the bot.

**Root cause:** The Discord OAuth callback handler relied solely on `guild_id` being present as a query parameter in the redirect URL. Discord does not always include this parameter (e.g. when the user has previously authorized, or with `prompt=none`). When `guild_id` was missing, the handler silently returned without creating the `gateway_clients` database row, so the CLI polled forever.

**Fixes:**

- Change Discord OAuth `prompt` from `none` to `consent` so the bot authorization screen always shows, ensuring `guild_id` is included in the callback
- Cache `guild_id` in KV before better-auth processes the callback, so the hooks.after handler has a reliable fallback source
- Store specific onboarding errors (missing guild_id, DB failures) in KV so the CLI can display them instead of a generic timeout
- CLI polling now detects and shows server-side onboarding errors immediately instead of waiting the full 5 minutes
- Fix unreachable "reopen install URL" hint (was checking `attempt === 150` in a loop that only runs 100 iterations)

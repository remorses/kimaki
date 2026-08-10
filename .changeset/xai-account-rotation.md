---
'kimaki': minor
---

Add xAI (Grok) multi-account OAuth rotation, matching the existing Anthropic and OpenAI rotation systems.

When an xAI account hits its usage limit (402 "balance exhausted" or 403 "spending-limit"), kimaki automatically switches to the next account in the rotation pool and resumes the session.

```bash
# List all xAI accounts in the rotation pool
kimaki multioauth xai list

# Show the current active account
kimaki multioauth xai current

# Remove an account by index or email
kimaki multioauth xai remove 2

# Test all accounts for usage limits
kimaki multioauth xai check
```

New accounts are detected automatically when you log in via `/login` in Discord. The rotation pool is stored at `~/.local/share/opencode/xai-oauth-accounts.json`.

Also enables the OpenAI rotation plugin which was created but never wired into the plugin loader.

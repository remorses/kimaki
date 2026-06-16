---
'kimaki': minor
---

Add `kimaki bot token` command that prints the bot token for CI and automation use.

```bash
# Print your token (works in both self-hosted and gateway modes)
kimaki bot token

# Store it as a GitHub Actions secret
kimaki bot token | gh secret set KIMAKI_BOT_TOKEN
```

In self-hosted mode this prints the Discord bot token. In gateway mode it prints the `clientId:clientSecret` credential. Either way, set it as `KIMAKI_BOT_TOKEN` in your CI environment.

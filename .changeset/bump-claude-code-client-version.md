---
'kimaki': patch
---

Advertise Claude Code `2.1.280` on Anthropic OAuth requests.

Anthropic rejects older Claude Code clients for some models:

```
Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required.
```

Subscription requests now send `user-agent: claude-cli/2.1.280 (external, cli)`, matching the current `@anthropic-ai/claude-code` release.

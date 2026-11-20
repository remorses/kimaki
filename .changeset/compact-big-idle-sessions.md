---
'kimaki': minor
---

Compact big idle sessions right before their prompt cache expires.

A Kimaki session over **500k tokens** of context is now compacted when it goes idle, while the provider cache still holds. The next prompt then writes a short summary to the cache instead of the whole history. Before, only coordinator sessions were compacted this way (they still compact from 100k tokens).

| OpenCode `warming` config | Compaction runs |
| --- | --- |
| off (default) | about 4 minutes after the last request, before Anthropic's 5-minute cache TTL |
| on | when OpenCode's warming ends: the last request plus its `duration` (30 minutes by default) |

```jsonc
// opencode.json: keep sessions warm for 1 hour, then Kimaki compacts the big ones
{ "warming": { "duration": "1 hour" } }
```

A session that still runs, for example inside a long tool call or waiting for an answer, is never compacted. TUI sessions are never touched.

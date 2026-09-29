---
'kimaki': minor
---

Background sync of external OpenCode sessions is now off by default. Pass `--enable-sync` to mirror sessions started from the OpenCode CLI or TUI into Discord threads. The `--disable-sync` flag is removed. The sync loop fetched full message history of recent sessions every 5 seconds, which caused constant CPU use on busy bots.

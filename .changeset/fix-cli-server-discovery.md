---
'kimaki': patch
---

CLI subcommands (`kimaki session list`, `kimaki session archive`, `kimaki send --wait`, etc.) now reuse the bot's already-running OpenCode server instead of spawning a redundant second server process.

Previously, these commands ran as separate OS processes where the in-memory server reference was null, causing each to start its own `opencode serve` instance. Now the bot's Hrana server exposes a `/kimaki/opencode-port` endpoint that CLI subcommands query to discover and health-check the existing server.

Fixes #170

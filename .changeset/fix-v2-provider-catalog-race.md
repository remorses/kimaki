---
'kimaki': patch
---

Fix Discord sessions that reported no connected AI provider after OpenCode v2 Subrouter restore.

Kimaki now waits for OpenCode plugin activation before reading the model catalog, does not cache empty connected-model snapshots, and loads Subrouter through the native v2 `aisdk:` provider package route. Project `opencode.json` providers such as the deterministic test provider still override generated defaults.

Fixes #220

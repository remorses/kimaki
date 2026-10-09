---
'kimaki': patch
---

Fix Discord sessions that reported no connected AI provider on OpenCode v2.

Kimaki now waits for OpenCode plugin activation before reading the model catalog, and does not cache empty connected-model snapshots. Project `opencode.json` providers such as the deterministic test provider still override generated defaults.

Fixes #220

---
'kimaki': patch
---

Revert pinned opencode binary download. Kimaki no longer bundles a specific opencode version; it requires opencode to be installed globally. On startup, the bot checks PATH and prompts to install if missing via `curl -fsSL https://opencode.ai/install | bash`. This avoids version skew issues where an older bundled opencode ran alongside a newer global one.

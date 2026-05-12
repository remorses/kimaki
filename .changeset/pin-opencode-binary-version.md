---
'kimaki': patch
---

Pin the opencode binary to a specific version (1.14.41) by downloading it from GitHub releases on first run instead of relying on a globally installed binary.

Previously, kimaki discovered the opencode binary via system PATH probing (`which`/`where`) and prompted users to install it during onboarding. This meant any new opencode release could break kimaki immediately for all users.

Now, the binary is downloaded to `~/.kimaki/bin/opencode-{version}` on first run with a spinner, cached across restarts, and old versions are cleaned up automatically. The `OPENCODE_PATH` env var still works as an explicit override.

Fixes #123
Fixes #124

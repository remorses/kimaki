---
'kimaki': patch
---

Kimaki now works without a separate OpenCode 2 install.

- **Bundled OpenCode.** `@opencode/cli` is a dependency of `kimaki`. When no OpenCode service runs, Kimaki starts one with `opencode2` or `opencode` from PATH if it is version 2.0.19 or newer, otherwise with the bundled binary. A user's own install still wins, so Kimaki and the OpenCode TUI share one service.
- **Early check.** `kimaki` checks for a running service or a usable binary before the Discord bot install. Before, a missing OpenCode was only reported after onboarding.

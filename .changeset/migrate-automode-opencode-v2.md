---
'@kimaki/automode': patch
---

Run auto mode through the native OpenCode 2 plugin API. Tool policy now runs in the native `execute.before` hook, so it also covers tools registered later by other plugins or MCP servers and each tool called from Code Mode. It reads the current user turn from native context, and uses one-shot generation for main-model classification without creating persistent classifier sessions.

The Jev classifier, read-only allowances, hard denies, timeout, confidence threshold, and fail-closed behavior remain unchanged.

Fixes #220

---
'@kimaki/automode': patch
---

Run auto mode through the native OpenCode 2 plugin API. Tool policy now wraps native v2 tools, reads the current user turn from native context, and uses one-shot generation for main-model classification without creating persistent classifier sessions.

The Jev classifier, read-only allowances, hard denies, timeout, confidence threshold, and fail-closed behavior remain unchanged.

Fixes #220

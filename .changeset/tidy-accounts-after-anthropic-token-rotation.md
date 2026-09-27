---
'kimaki': patch
---

Fixes #227

Anthropic OAuth token rotation now updates the existing account instead of adding duplicates, and rate-limit retries try each available account once.

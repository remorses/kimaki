---
'kimaki': patch
---

Inject the Kimaki system prompt into OpenCode v2 LLM context.

v2 `session.command` has no `system` field. Kimaki already writes the prompt to disk. The v2 plugin now attaches that file on `session.hook("context")`, so slash commands still get Discord upload instructions and other Kimaki system text.

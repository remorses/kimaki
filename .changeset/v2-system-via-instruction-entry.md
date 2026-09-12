---
'kimaki': patch
---

Inject the Kimaki system prompt through OpenCode v2 `session.instructions.entry.put`.

v2 `session.prompt` and `session.command` have no `system` field. Kimaki now writes the full session-stable prompt as instruction entry `kimaki` after session create. Chat, slash commands, tools, and compaction all see it. The sqlite `session_system_contexts` side channel and the plugin rebuild of that prompt are gone.

Kimaki now uses published OpenCode **2.0.2** (`@opencode/cli`, `@opencode/client`, `@opencode/plugin`) so the instruction-entry size limit is 256 KiB.

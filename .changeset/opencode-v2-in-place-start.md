---
'kimaki': minor
---

Port Kimaki onto OpenCode v2 in place. The Discord bot still lives in `cli/`. It now spawns `opencode2` and talks through `@opencode-ai/client`.

Normal chat uses `session.prompt` with `delivery: "steer"`. `/queue` uses `"queue"`. `/abort` uses `session.interrupt`. Discord renders from `session.text.ended`, `session.tool.*`, and `session.execution.succeeded`. The old 3s abort-and-replay plugin is gone.

Fixes #220

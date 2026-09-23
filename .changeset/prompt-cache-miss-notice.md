---
'kimaki': minor
---

Show a silent Discord status line when prompt cache is lost mid-session.

Kimaki compares `tokens.cache.read` on consecutive completed assistants of the same model. If cached input drops while the prompt did not shrink, it posts `prompt cache missed (20k → 0)`. If the Kimaki system string also changed, the line includes `system +4 -1`.

A full unified diff of the OpenCode system prompt is written to `~/.kimaki/cache-rewrites/<time>-<session>.patch` when a plugin or agent prompt changes it. Equal prompts are not written.

This is skipped on the first assistant, model changes, aborts, compaction, pruning, and any smaller prompt.

---
'kimaki': patch
---

Fix missing kimaki system prompt on the first turn of OpenCode commands.

OpenCode's `session.command` API has no `system` field, so slash commands and leading `/command` messages skipped the Discord context kimaki injects on normal `promptAsync` turns (session/thread IDs, upload helpers, etc).

Kimaki now persists the session system prompt before `session.command` and the OpenCode plugin attaches it on `chat.message` when the user message would otherwise have no system field.

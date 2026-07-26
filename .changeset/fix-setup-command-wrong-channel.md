---
"kimaki": patch
---

Reply with guidance when running `/add-project` or `/create-new-project` in a non-project channel.

Previously these commands were silently ignored when invoked in a channel that is not owned by the receiving machine, leaving users with no feedback. The bot now replies with an ephemeral message directing the user to run `kimaki project add` from the terminal to create a new project channel.

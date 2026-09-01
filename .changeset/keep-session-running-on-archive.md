---
'kimaki': patch
---

Keep the mapped OpenCode session running when a Discord thread is archived.

Archiving now only hides the thread and marks its title. Active work and queued messages continue normally, so queued prompts are not lost or reordered. Use `kimaki session abort <session_id>` when the running session must stop.

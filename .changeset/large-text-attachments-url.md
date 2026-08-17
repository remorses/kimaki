---
'kimaki': patch
---

Stop inlining large Discord text attachments into the model prompt.

Every text attachment is saved under `~/.kimaki/attachments/`. The prompt always includes the local path and Discord URL. Files over 64 KB omit the file contents and tell the agent to read the local path. Small text files and `prompt.md` from `kimaki send` still inline as before.

---
'kimaki': patch
---

Fix parallel `kimaki send` failures when multiple long prompts are dispatched at once.

Long prompts used to be written to a shared temp path and unlinked after upload. Concurrent sends from the same working directory could race on create/cleanup and fail with `ENOENT` before the Discord thread was created.

Long prompt attachments now build `prompt.md` in memory and upload it directly. No temp file is created, so parallel sends cannot delete each other's attachments, and cleanup no longer throws when a path is already gone.

```bash
# safe to run many long prompts at once
kimaki send --channel <id> --prompt "$(cat long-task-1.md)" &
kimaki send --channel <id> --prompt "$(cat long-task-2.md)" &
wait
```

Fixes #178

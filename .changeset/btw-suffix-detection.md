---
'kimaki': patch
---

Change `btw` shortcut from prefix to suffix detection. Now only triggers when preceded by punctuation or a newline (e.g. `fix the bug. btw check tests`), matching the same pattern as the queue suffix. The text before `btw` continues in the current session while the btw prompt forks to a new thread.

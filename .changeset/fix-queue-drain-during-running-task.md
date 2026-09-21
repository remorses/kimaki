---
'kimaki': patch
---

Keep `. queue` messages waiting while a `task` subagent is still running.

Kimaki used to treat the parent session as idle once child-task events filled the 1000-event buffer and pushed out parent busy/lifecycle events. The 3s interrupt plugin then aborted the in-flight task, so a message ending in `. queue` interrupted instead of waiting.

Queued follow-ups now stay queued until the parent task actually finishes.

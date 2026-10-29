---
'kimaki': patch
---

After an automatic compaction the thread now shows the new context size, for example `context compacted to 179k tokens (18%)`. A compaction with no model request after it (a manual `/compact`, or the idle compaction of a coordinator channel) posts no line, so a channel you already read stays quiet. `/compact` keeps its `Compacting the session context` reply. Status lines (retries, cache misses, finished subagents and shells, voice call notices) and worktree thread names no longer start with ⬦.

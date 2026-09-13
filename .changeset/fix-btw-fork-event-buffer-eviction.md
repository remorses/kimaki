---
'kimaki': patch
---

Keep `/btw` from freezing Discord updates in the original thread.

`/btw` still does not abort the parent OpenCode run. A fork copies the source history into a new session, and that clone flood used to fill the parent's 1000-event buffer. After eviction, Kimaki skipped the rest of the parent turn in Discord even though the model was still working.

Kimaki now buffers only the current thread session and its task/subagent children, so a side-question fork can run in parallel without hiding the original thread.

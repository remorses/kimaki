---
"kimaki": patch
---

Fix `external-opencode-sync` leaking internal plugin/agent sub-sessions as `Sync:` Discord threads. Sessions with a `parentID` (forks) are now skipped in addition to the existing `new session -` / `(subagent)` title filters, so plugins that spawn sub-sessions (memory recall, memory extraction, research sub-agents) no longer each create a junk thread per real session.

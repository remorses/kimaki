---
'kimaki': patch
---

Stop finished Discord sessions from being re-posted as if they were OpenCode TUI sessions.

A live Kimaki thread runtime stays the only Discord writer. Compaction user messages and compaction summaries stay out of Discord ownership and mirroring, so auto-compact cannot flip a Discord session to TUI sync.

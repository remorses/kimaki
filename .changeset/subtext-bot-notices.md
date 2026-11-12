---
'kimaki': patch
---

Show bot notices as Discord subtext, so only the model's answer is full-width text.

- A `. btw` or `/btw` fork thread now starts with `-# Reusing context from #thread` and your question as `-# » **you:** question`, instead of plain text that looked like an agent reply.
- `Session forked! Continue in #thread`, `Started a new session in #thread` and `Delivered to #thread` acks are subtext.
- `/fork`, `/fork-subagent`, `/resume` and `/new-worktree` thread intros and their closing notes are short subtext lines.
- Error messages (`✗ ...`) are one subtext line.
- Status replies of `/abort`, `/compact`, `/undo`, `/redo`, `/clear-queue`, `/reset-coordinator`, `/new-session` and `/resume` are subtext.

---
'@subrouter/opencode': patch
'kimaki': patch
---

Keep cooldown fallback notices visible without starting empty OpenCode agent turns.

Subrouter now persists each `Subrouter: Using <fallback> because <preferred> is rate limited.` notice during the active run, using OpenCode's `noReply` and ignored-text message pattern. It no longer writes the notice from `session.idle`, where it could race with run shutdown and become the parent of another assistant turn.

Kimaki external session sync now ignores these display-only message parts. This prevents a Subrouter notice from reclaiming the thread as an external OpenCode session or mirroring a duplicate user message into Discord.

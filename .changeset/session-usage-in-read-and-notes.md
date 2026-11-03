---
'kimaki': minor
---

Show context size and run time of sessions, and start fresh sessions instead of waking cold long ones.

`kimaki session read` now prints a usage line under the header:

```
context: 412k tokens, last run took 12m 30s, last active 23m ago (2026-10-31T10:00:00.000Z)
```

Coordinator `<session-finished>` notes carry the same data as `context="412k tokens" duration="12m 30s"`.

Agents use it to avoid expensive follow-ups: when a session has more than 400k tokens of context and was last active more than 10 minutes ago, its prompt cache has expired, so a follow-up would write the whole context again. The agent starts a new session with the old thread's Discord URL in the prompt instead, and the new session reads it with `kimaki session read <url> --thinking`.

Agents now read sessions from Discord links with `--thinking` by default, so they see tool calls and reasoning, like the transcripts, not only prompts and final answers.

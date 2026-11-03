---
'kimaki': minor
---

**`/context-usage` shows whether the session is still working.** Use it when a thread shows only the typing indicator for a long time. The status comes from OpenCode's message timestamps, so Kimaki posts nothing new in the thread.

```
**Context usage:** 41%, 82,310 / 200,000 tokens
**Model:** anthropic/claude-opus-4-6
**Status:** running for 4m 12s, running shell for 3m 50s
**Last activity:** 3m 50s ago, shell
```

- **Running**: how long since the last prompt, then what the model does now: thinking, a tool and how long it runs, waiting for the model, or writing.
- **Idle**: `idle for 12m 3s`, or `idle, the last prompt (2m 5s ago) has no reply` when nothing answered it.

Fixes #253

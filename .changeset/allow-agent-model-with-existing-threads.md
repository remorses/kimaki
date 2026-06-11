---
'kimaki': patch
---

Allow `--agent` and `--model` flags with `--thread`/`--session` in `kimaki send`.

Previously the CLI rejected these flags for existing threads with "Incompatible options with --thread/--session", even though the bot already supports reading agent/model from the embed marker. The system message documentation also recommended this usage pattern.

Now `--agent` and `--model` are accepted and included in the thread prompt marker so the bot picks them up and applies them to the session.

```bash
# previously rejected, now works
kimaki send --thread 123456 --prompt 'fix the bug' --agent plan
kimaki send --session ses_abc --prompt 'run tests' --model anthropic/claude-sonnet-4-20250514
```

Fixes #146

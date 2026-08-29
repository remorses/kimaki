---
'kimaki': minor
---

Validate `--model` against the live OpenCode model list before send, task create/edit, and session start.

Unknown or disconnected models now fail immediately instead of being stored and breaking later.

```sh
kimaki send --model anthropic/claude-opus-4-6 --prompt 'review this'
kimaki task edit 12 --model openai/gpt-5.4
```

Use `provider/model`. Empty `--model` on `task edit` still clears the override.

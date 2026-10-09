---
'kimaki': minor
---

Disable the OpenCode `question` tool in Kimaki sessions. The agent offers choices with `kimaki buttons` instead.

New sessions are created with this OpenCode permission rule, so the tool is removed from the model's tool list. Forks and subagent sessions inherit it, and `/resume` adds it to the resumed session.

```json
{ "action": "question", "resource": "*", "effect": "deny" }
```

The system prompt now tells the agent to use `kimaki buttons` for 1 to 3 options, and plain text for longer lists or open questions.

To turn the tool back on for one session, pass a permission rule:

```bash
kimaki send --channel <channel_id> --prompt 'Pick a color' --permission question:allow
```

Forms from OpenCode itself, like the web search setup form, still show as Discord dropdowns.

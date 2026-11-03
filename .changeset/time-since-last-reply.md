---
'kimaki': minor
---

Tell the model how much time passed since its last message. Every prompt in a Kimaki session that follows an assistant reply now reaches the model with a short note:

```
[2h 5m since your last message]
```

The agent can tell a quick follow-up from a user coming back after a break. The gap is stored in the prompt metadata when the prompt is sent, so the text stays the same on every request and the prompt cache keeps hitting. The stored prompt text stays clean in the OpenCode TUI. TUI sessions not started by Kimaki are not changed.

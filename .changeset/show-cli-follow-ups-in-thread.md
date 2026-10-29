---
'kimaki': patch
---

Show follow-up prompts sent with `kimaki send --thread` in the Discord thread. Before, a prompt sent to an existing thread that was idle (with or without `. queue`) ran without any line in Discord, so a coordinator follow-up to a worker looked like the agent started work on its own. Now the thread shows it like the first prompt:

```
-# » **CLI:** Continue the release task. Fix the performance blocker first.
```

This also covers `kimaki session queue add`, `kimaki session command` and OpenCode commands like `/review` sent from the CLI or a routine, which now show the typed command. Remote sends and clicked `kimaki buttons` stay as they were: their Discord message already shows the prompt.

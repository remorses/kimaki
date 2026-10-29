---
'kimaki': patch
---

Show each queued prompt once. When a queued prompt starts running, Kimaki no longer posts its text again as `» **Tommy:** ...`. A short reply marks where it runs instead.

A queued Discord message (or `/queue`) gets the reply on the original message, and its `Queued at position 1` notice changes to `Queued`:

```
Tommy: commit everything with a descriptive message. queue
  ↳ -# Queued
...
↳ replying to Tommy: -# Queued message sent
```

Coordinator channels get the same reply. It shows that the queued prompt started even when the coordinator answers with no text, for example after it starts a worker. The answer that follows is not a second reply to the same message.

A prompt queued with `kimaki send --thread ... . queue` (or a routine, or the OpenCode TUI) has no Discord message. Before, the thread only showed `Queued at position 1` and later `Queued message sent`, with no hint of what was queued. Now the queue notice holds the prompt as subtext, and the reply goes to that notice:

```
-# » **CLI:** Run the tests after your current work
-# Queued at position 1. Remove it with /clear-queue position:1
...
↳ -# Queued message sent
```

Long prompts are cut to fit one Discord message. A `/queue-command` notice now also replies to its `» user: /command` line.

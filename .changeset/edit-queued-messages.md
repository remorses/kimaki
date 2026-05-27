---
'kimaki': minor
---

Support editing queued messages via Discord message edits.

When a user edits a Discord message that is still waiting in kimaki's local queue
(messages ending with `. queue`), the queue item is updated with the new content.
If the edit removes the queue suffix, the item is removed from the queue entirely.

```
User sends:    "fix the bug. queue"     → queued at position 1
User edits to: "fix it properly. queue" → queue item updated
User edits to: "fix it properly"        → item removed from queue
```

This uses the `Events.MessageUpdate` gateway event. Messages that were already
dispatched to opencode (dequeued) are unaffected by edits.

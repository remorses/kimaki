---
'kimaki': patch
---

Bring back `/model-variant` and `/clear-queue` slash commands.

They were removed in favor of buttons attached to `/model` and `/queue`
replies, but a direct command is still handy when you already know what
you want to change without waiting for a reply message.

```
/model-variant          # pick a thinking level for the current model
/clear-queue             # clear all queued messages in this thread
/clear-queue position:2  # clear only the message at queue position 2
```

The button-based flows on `/model` ("Change thinking level") and
`/queue` ("Remove from queue") still work as before.

---
'kimaki': patch
---

Show a queued prompt starting as a silent reply instead of repeating the prompt text.

Before, when a queued message started, Kimaki posted the whole prompt again:

```
» **Tommy:** Reply with exactly: queued-from-slash
```

Now Kimaki replies to the message that queued it, with a short subtext line and no ping or notification:

```
┌ Tommy: fix the tests queue
-# Executing queued prompt
```

For `/queue` and `/queue-command`, the reply points to the "Queued message" confirmation. For messages ending in `queue`, it points to your own message. If no reply target exists, the line includes the author and a short preview.

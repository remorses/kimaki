---
'kimaki': patch
---

AskUserQuestion dropdowns no longer expire after 10 minutes.

A pending question now waits until you answer it, send a new message, or run `/abort`. Stepping away for an hour no longer kills the run in every waiting thread.

Permission buttons still time out after 10 minutes (or `--permission-timeout-minutes`). A permission timeout can auto-reject and let the model keep working. A question cannot fake an answer, so expiring one could only abort the session.

`/abort` now also clears the pending dropdown, and a question whose Discord message fails to send no longer leaves the session blocked forever.

Fixes #192

---
'kimaki': patch
---

Fix native OpenCode v2 abort follow-ups and question-queue drain.

After an explicit abort, Kimaki now waits for the **current** execution to settle before sending the next prompt, so a still-running interrupt cannot kill the follow-up. Queued messages during a pending question now use native **queue** delivery instead of steer, so answering the dropdown drains one item at a time.

Fixes #220

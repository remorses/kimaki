---
'kimaki': minor
---

Queue a context-preserving side question until the current turn finishes.

In a Discord session thread, send `Explain the error. btw queue` or use `/queue` with `Explain the error. btw`. You can also put `. queue` at the end of a `/btw` prompt. Kimaki waits for earlier queued prompts to finish, then forks the **updated** source session into a new thread. The side question never starts a turn in the source thread.

Queued side questions support the normal queue controls: edit or delete the Discord message before it starts to change or remove it. A side question sent from an existing `btw:` thread can also queue another fork.

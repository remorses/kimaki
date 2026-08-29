---
'kimaki': patch
---

Show the assistant text that comes before a question **before** the dropdown and before any queued `» user:` handoff.

OpenCode can emit `question.asked` while the previous text part is still open. Kimaki used to await the Discord dropdown on the action queue, so that text only posted after the next queued prompt fired.

The question UI now waits until that text part ends, then flushes, then shows the dropdown, then hands off the queue.

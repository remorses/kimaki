---
'kimaki': patch
---

Show the run footer and typing indicator for OpenCode v2 sessions.

Kimaki now waits until the event stream is actually connected before sending a prompt, so the first-turn assistant text is not missed. The footer is emitted when a drain succeeds after `text.ended` or `tool.called`. Typing starts when the session is busy, including `session.step.started`, and stops before the footer. Failed drains post the error in the thread instead of going silent.

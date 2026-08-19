---
'kimaki': patch
---

Post delegated task lines in Discord when the child starts, not when it finishes.

OpenAI often puts the task name in `state.title` instead of `input.description`. Kimaki still uses that title, but only on the **running** event. The completed event is ignored so the line does not appear after the follow-up text.

```
┣ general **Classify pending changes**
```

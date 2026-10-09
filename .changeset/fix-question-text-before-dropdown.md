---
'kimaki': patch
---

Post plan text before a question dropdown when OpenCode v2 opens the form while text is still streaming.

v2 can emit `form.created` before `session.text.ended`. Kimaki now waits for that text so the question UI does not hide the earlier message.

Fixes #208

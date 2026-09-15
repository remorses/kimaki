---
'kimaki': patch
---

Keep synthetic user prompt context out of Discord.

Kimaki now hides injected user parts such as `[current git branch is main]` and `<discord-user />`. Subrouter fallback notices still post as silent bot messages.

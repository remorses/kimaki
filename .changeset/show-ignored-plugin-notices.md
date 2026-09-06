---
'kimaki': patch
---

Show ignored plugin notices in Discord.

Plugins like Subrouter inject display-only user text with `ignored: true` so the model never sees it. Kimaki now posts that text as a silent bot message, for example `Subrouter: Using openai/gpt-5.6-sol because xai/grok-4.6 is rate limited.`

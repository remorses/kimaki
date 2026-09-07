---
'kimaki': patch
---

Stop mentioning the bot in final session footers.

When the bot creates a thread (`kimaki send`, slash commands), the footer now pings the first human thread member instead of the bot. If no human member is in the thread, the footer stays silent.

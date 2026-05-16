---
'kimaki': patch
---

Clear stale global Discord slash commands during startup.

Kimaki registers slash commands as guild commands so updates are immediate. Startup now also bulk-clears global commands for self-hosted bots, removing older commands that are no longer registered and preventing duplicate stale entries from staying visible in Discord.

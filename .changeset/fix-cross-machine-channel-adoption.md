---
'kimaki': patch
---

Stop adopting the default "kimaki" channel from another kimaki instance in shared guilds.

When two kimaki installations (different `client_id`) are connected to the same Discord guild via the gateway proxy, the second instance would find the first instance's "kimaki" channel by name and claim it in its local DB. This caused both machines to handle messages in the same channel, creating duplicate sessions.

Now if a "kimaki" channel exists in the guild but isn't already in the local database, the bot skips it instead of adopting it. Each instance only manages channels it created itself.

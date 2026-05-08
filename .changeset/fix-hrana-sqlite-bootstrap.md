---
'kimaki': patch
---

Fix fresh SQLite database startup when Kimaki connects through the local Hrana HTTP bridge.

Fresh test and plugin databases now receive the same schema bootstrap as direct `file:` connections, preventing `no such table: bot_tokens` errors before the first bot token is stored.

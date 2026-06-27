---
'kimaki': patch
---

Fix `project add` and `project create` selecting the wrong Discord guild in gateway mode.

The guild selection heuristic fetched the most recent channel from the database to determine
which guild to use, but that channel could belong to a different bot instance (e.g. old
self-hosted bot). In gateway mode, the proxy rejects the REST call and the fallback
`client.guilds.cache.first()` non-deterministically picked the wrong guild from the shared
bot's cache.

The new approach tries multiple existing channels before falling back, and the fallback
correctly relies on the guild cache which in gateway mode is already filtered to authorized
guilds by the proxy's READY payload.

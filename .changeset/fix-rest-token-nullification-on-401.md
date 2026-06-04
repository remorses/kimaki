---
'kimaki': patch
---

Fix bot becoming permanently unresponsive after gateway proxy transient outages.

`@discordjs/rest` automatically calls `setToken(null)` on any 401 HTTP response.
When the gateway proxy returns 401 during brief DB stale periods, this permanently
kills the REST token and every subsequent Discord API call fails with "Expected token
to be set for this request, but none was present". The bot cannot recover without a
manual restart.

The fix overrides `setToken` to block null values. The 401 error still propagates
normally (individual calls fail during the outage), but the token stays set so calls
succeed as soon as the proxy recovers.

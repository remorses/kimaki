---
'kimaki': patch
'discord-digital-twin': patch
---

Fix the bot losing its Discord token after the gateway answered 401 once. `@discordjs/rest` clears its token on any 401, so after a gateway-proxy restart every message, typing pulse and scheduled task failed with `Expected token to be set for this request` until Kimaki restarted. Users also saw their messages ignored with a misleading "no Kimaki permission" log. Kimaki now keeps the token and the next request works again. A failed permission check now logs the real error.

`discord-digital-twin`: `revokeGatewayClient({ token })` makes the gateway-proxy mode answer 401 for a client, like a proxy restart with an empty client registry.

---
'kimaki': patch
---

Keep the bot running when Discord login fails because the network is down.

A connect timeout to `discord-gateway.kimaki.dev` (or other undici timeout/socket errors) used to exit with code 64, so the auto-restart wrapper stopped permanently. Those errors now exit as a temporary failure. The wrapper retries with backoff and does not treat a long outage as a crash loop.

When the internet comes back, Kimaki reconnects and sessions keep working.

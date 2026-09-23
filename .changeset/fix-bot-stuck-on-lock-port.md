---
'kimaki': patch
---

Fix Kimaki failing to start with `Failed to start hrana server: Server failed to start on port 29988: Port 29988 still in use after eviction`.

Pressing Ctrl+C (or sending `SIGTERM`) while the bot was still starting up, before Discord finished loading channels, was silently ignored. The old process kept running on the lock port, and every next `kimaki` start failed until you killed it by hand.

- Ctrl+C, `SIGTERM` and closing the terminal (`SIGHUP`) now stop the bot cleanly at any point of startup
- a new `kimaki` start now force-kills an old instance that does not exit within 20 seconds, instead of giving up
- if the `kimaki` restart wrapper dies for any reason, the bot process now exits too instead of staying orphaned on the port

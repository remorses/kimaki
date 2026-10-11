---
'kimaki': patch
---

Make Ctrl+C stop the bot in about half a second instead of about 5 seconds.

On shutdown Kimaki closes its Discord gateway WebSocket. Through the shared gateway (`kimaki --gateway`), the hosting proxy kept the closed connection open for about 5 more seconds, and shutdown waited for it. Kimaki now waits at most 500ms for that close. The close frames are already exchanged by then, so nothing is lost.

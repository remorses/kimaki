---
'kimaki': patch
---

Messages sent while the bot was offline or restarting are now handled after it reconnects, instead of failing with "OpenCode not connected". gateway-proxy replays these messages right after the Discord connection is ready, which is often before the OpenCode connection is ready. Kimaki now waits for OpenCode before it handles any Discord message.

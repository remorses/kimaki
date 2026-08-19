---
'kimaki': patch
---

Recover automatically when the bot hangs while shutting down for a self-restart.

After Discord gateway failures, `process.exit()` can hang while Node joins native worker threads. The bot now sends `SIGKILL` to itself after cleanup, and the restart wrapper force-kills the child if it does not exit within 15 seconds.

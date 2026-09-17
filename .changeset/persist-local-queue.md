---
'kimaki': patch
---

Keep `/queue` messages across bot restarts.

Queued messages now live in SQLite. After a restart, Kimaki restores them and sends the next one when the session is idle. Remove-from-queue buttons still work after restart.

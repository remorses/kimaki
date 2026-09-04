---
'kimaki': patch
---

Stop aborting running sessions when a hidden context notice arrives.

Subrouter posts ignored fallback notices while a turn is already busy. The interrupt plugin treated those as queued user messages and cancelled the current work, including oracle subagents, after 3 seconds.

The plugin now skips messages whose parts are all marked `ignored`.

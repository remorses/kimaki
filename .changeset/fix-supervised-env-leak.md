---
'kimaki': patch
---

Fix `KIMAKI_SUPERVISED` leaking from the bot into OpenCode and agent shells.

The supervisor marks its bot child with `KIMAKI_SUPERVISED=1`. The bot kept it in `process.env`, so the OpenCode service and every agent shell inherited it. A kimaki bot started from a session (for example in tests) then thought it was supervised: `kimaki restart` sent SIGTERM to its own process and nothing started it again, and `kimaki` skipped the supervisor.

- The bot removes the variable from `process.env` at startup and keeps the supervised state on the lock server.
- `kimaki` treats itself as the supervised child only when the variable is set and its IPC channel to the supervisor is connected, so a stale value in an old shell is ignored.

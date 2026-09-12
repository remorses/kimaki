---
'kimaki': patch
---

Stop treating an intentional OpenCode server shutdown as a crash.

Kimaki now records the exact child it asked to stop. After `/restart` or test teardown, a server that exits `130` with no signal no longer comes back on its own.

If the child dies while Kimaki is still waiting for readiness, startup fails on the next poll and includes the last stderr lines. You no longer wait 30 seconds for a dead process.

---
'kimaki': patch
---

Replace per-thread SSE event listeners with a single global SSE connection.

Previously every Discord thread opened its own SSE connection to the opencode
server's `/event` endpoint. With 20+ idle threads, all connections would
disconnect and reconnect simultaneously, flooding logs with "Stream ended
normally, reconnecting" messages and wasting server resources.

Now there is one connection to `/global/event` (the same endpoint the opencode
TUI uses). Events are broadcast to all registered thread runtimes; each
runtime's existing `handleEvent()` filters by sessionId. The per-thread SSE
reconnect loop (~140 lines) is deleted entirely.

Fixes #126

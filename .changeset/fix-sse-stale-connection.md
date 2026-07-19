---
'kimaki': patch
---

Fix the global SSE event listener getting stuck on stale connections. When the OpenCode server's event stream appears alive (TCP keep-alive) but stops delivering events, the listener now detects the stall after 2 minutes of no events and automatically reconnects. This prevents sessions from becoming permanently stuck when the SSE connection silently stalls—previously the listener would wait forever and miss events like `permission.replied`, leaving the session in a busy state with no way to recover.

Additionally, fix sessions waiting on interactive UI (permissions or questions) getting stuck when the SSE stream stalls. A dedicated watchdog timer now detects when no response is received within 5 minutes and automatically aborts the session so the user can retry.

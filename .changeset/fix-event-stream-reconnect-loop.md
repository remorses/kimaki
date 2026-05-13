---
'kimaki': patch
---

Fix infinite event stream reconnect loop that locked up the bot when the opencode SSE endpoint closed the connection normally.

The listener loop now delays before reconnecting on normal stream completion, with exponential backoff (500ms up to 30s). Backoff only resets after the stream delivers at least one event, so immediately-closing streams escalate backoff instead of hammering the server.

Fixes #126

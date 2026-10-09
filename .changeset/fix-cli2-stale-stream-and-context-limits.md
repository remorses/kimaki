---
'kimaki': patch
---

Recover from a silent OpenCode event stream and keep footer context usage current in the V2 rebuild.

- Reconnect when the event stream sends nothing for 45 seconds (three missed server keepalives), for example after the computer wakes from sleep.
- Read model context windows again after `/login` or other provider, model, or credential changes, so footers show the context percent for newly added models.
- Forget tool calls whose end was missed while disconnected, once nothing runs in the thread.

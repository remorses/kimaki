---
'kimaki': patch
---

Surface the full error cause chain when OpenCode SDK calls fail in `dispatchAction`, instead of only showing the generic `"OpenCode SDK call failed: dispatchAction"` wrapper. Users now see the underlying error message (e.g. provider timeout, session error) in Discord, and the full error stack is logged for operator debugging.

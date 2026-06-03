---
'kimaki': patch
---

Fix `/model` and `/model-variant` not applying to the current session when scope is "global" or "channel".

Previously, selecting "global" or "channel" scope would persist the preference to the database but the current running session would keep using the old model until the next message. Now all three scopes (session, channel, global) update the current session and restart the current request with the new model, matching the behavior that "session" scope already had.

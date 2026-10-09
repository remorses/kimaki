---
'kimaki': patch
---

`/model` shows reset buttons when an override is set, so you can go back to the default model in one click.

- **Reset session model** (in a thread): appears when the session model differs from the channel default. It switches the session back to the model a new session in this channel would use (channel model, channel agent model, global model, or the OpenCode default). Applies from the next step.
- **Reset channel model**: appears when the channel has its own model. It removes it, so new sessions use the global `/model` default.

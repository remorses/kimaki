---
'kimaki': minor
---

Add an **All channels** scope to `/model`, like V1. It sets the default model and thinking level of new sessions in every channel that has no model of its own.

A model passed explicitly, the channel's own model, and an agent's configured model win over the global model. The OpenCode default applies only when none is set. The `/model` header shows `Current (global)` when a channel uses the global model.

From the CLI, use `kimaki channel model provider/model --global` to set it, and `kimaki channel model --global --clear` to remove it. `kimaki channel agent` and `kimaki channel verbosity` no longer show options they ignored (`--variant`, and `--clear` for verbosity).

The V1 import now copies your saved global model.

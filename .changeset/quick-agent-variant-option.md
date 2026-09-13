---
'kimaki': minor
---

Add an optional **variant** parameter to `/plan-agent`, `/build-agent`, and other `xxx-agent` slash commands.

It is the last option, after **prompt**. Use it to set the model thinking level when you switch agents:

```
/plan-agent variant: high
/build-agent prompt: fix the login bug variant: max
```

Autocomplete lists the thinking levels supported by that agent's model.

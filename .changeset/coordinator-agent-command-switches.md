---
'kimaki': patch
---

`/<agent>-agent` without a prompt in a coordinator channel switches the coordinator session to that agent again, instead of starting a new empty thread. With a prompt it still starts a new thread with that agent, and the coordinator keeps its own agent and model.

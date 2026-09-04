---
'kimaki': patch
---

Show the live Subrouter model in `/model` and session footers.

When the current model is a Subrouter preset such as `subrouter/build`, Discord now shows the in-flight provider/model for that session, for example `subrouter/build (opencode-go/fake-model)`. After the session goes idle, it falls back to the next cooldown-aware candidate.

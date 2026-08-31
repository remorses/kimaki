---
'kimaki': patch
---

Show the live routed model next to `subrouter/build` in the session footer and `/model`.

Subrouter already puts that name on the OpenCode model via the SDK (`build (claude-opus-4-6)`). Kimaki now reads it from `provider.list` instead of printing only the preset id.

```
*kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ build (claude-opus-4-6)*
**Current (this thread):** `subrouter/build (claude-opus-4-6)`
```

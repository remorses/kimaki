---
'kimaki': patch
---

Keep `/btw` child threads from ingesting the parent event stream.

A new `/btw` runtime used to listen to global SSE before its session id was bound. Until then it buffered every scoped event, including the parent clone flood. Kimaki now binds the forked session id before the listener starts, and drops scoped events while a thread has no session id.

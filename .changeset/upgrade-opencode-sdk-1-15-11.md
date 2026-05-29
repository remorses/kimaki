---
'kimaki': patch
---

Upgrade `@opencode-ai/sdk` and `@opencode-ai/plugin` to `1.15.11`.

The newer SDK event types require a top-level `id` field on every event, so synthetic queue-gating events (`session.status` / `session.idle` emitted around local queue drains) now include a generated id. SDK error response shapes also changed across routes, so error message extraction is centralized in a new `extractSdkErrorMessage()` helper that probes every known shape (`data.message`, `message`, `errors[]`, `_tag`) and is reused by `/compact` and the session prompt error path.

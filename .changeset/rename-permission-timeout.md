---
"kimaki": patch
---

Add `--interaction-timeout-minutes` CLI flag as an alias for `--permission-timeout-minutes`, and expand the timeout to cover question dropdowns in addition to permission buttons.

Previously, the timeout only controlled permission buttons; question dropdowns used a hardcoded 10-minute TTL. The new flag (and the existing `--permission-timeout-minutes` flag, kept for backward compatibility) now controls both interaction types. The internal state field is renamed from `permissionTimeoutMs` to `interactionTimeoutMs` to reflect this broader scope.

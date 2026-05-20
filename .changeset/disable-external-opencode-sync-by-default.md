---
"kimaki": patch
---

Disable external OpenCode session sync by default so the Discord bot does not continuously initialize OpenCode for every tracked project. Users who want to mirror sessions started outside Discord can opt in with `KIMAKI_ENABLE_EXTERNAL_OPENCODE_SYNC=1`.

Also sanitize model/provider select menu options so missing model names fall back to model IDs instead of producing invalid Discord select options.

---
'kimaki': patch
---

Make OpenCode event JSONL files contain one unwrapped native event per line. Live debug logs and `kimaki session export-events-jsonl` now preserve the exact event schema without adding Kimaki timestamps, thread IDs, or project directories.

Fixes #220

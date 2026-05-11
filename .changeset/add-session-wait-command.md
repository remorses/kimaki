---
'kimaki': minor
---

Add `kimaki session wait <sessionId>` for waiting on an existing session without passing a project path.

The command resolves Kimaki-managed sessions from the local database, waits until OpenCode is idle, keeps waiting while permission or question prompts are pending, and prints the final session markdown to stdout.

---
'kimaki': patch
---

Fix plugin tools targeting the wrong Discord thread after `/resume`.

`/resume` binds an existing OpenCode session to a **new** thread without clearing the old row, so one session can map to several threads. The reverse lookup used to return an arbitrary one, which meant `kimaki_file_upload` and `kimaki_action_buttons` could show their prompt in a stale thread and then wait for a click that never came.

Thread bindings now record when they happened, and the lookup resolves a session to its **most recently bound** thread. Rebinding an older thread makes it current again, which `created_at` ordering alone could not express.

The bind timestamp is written explicitly on both the insert and the update path. SQLite's `CURRENT_TIMESTAMP` default stores `YYYY-MM-DD HH:MM:SS` while JavaScript dates store ISO with a `T`, and those two text formats do not sort against each other correctly.

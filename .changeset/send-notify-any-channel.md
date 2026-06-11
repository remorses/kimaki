---
'kimaki': patch
---

Allow `kimaki send --channel <id> --notify-only` to target any Discord channel, even if it is not registered as a kimaki project. Previously the command required every channel to have a project directory mapping, which blocked simple notification use cases like posting alerts or reminders to arbitrary channels.

When `--notify-only` is used with a channel that has no project directory, the thread is created normally but without session auto-start (as expected for notify-only). Scheduled tasks (`--send-at`) also work because `projectDirectory` is already optional in the database.

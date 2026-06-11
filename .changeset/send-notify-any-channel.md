---
'kimaki': patch
---

Allow `kimaki send --channel <id> --notify-only` to target any Discord channel, even if it is not registered as a kimaki project. Previously the command required every channel to have a project directory mapping, which blocked simple notification use cases like posting alerts or reminders to arbitrary channels.

When `--notify-only` targets a non-project channel, the message is posted directly without creating a thread. For project channels, a thread is still created so users can reply to start a session. Scheduled tasks (`--send-at`) also work because `projectDirectory` is already optional in the database.

---
'kimaki': minor
---

Scheduled-task sessions now get a `## scheduled task session` section in the system message: which task started the session (task ID for cron tasks), the cron expression with its timezone (or a note that a one-time task runs once), and an explicit instruction not to use `kimaki_sleep` between runs since the task spawns a new session on its own schedule.

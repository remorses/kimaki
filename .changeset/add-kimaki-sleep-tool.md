---
'kimaki': minor
---

Add the `kimaki_sleep` tool so a session can pause itself for hours or days, then wake up in the same thread and keep working.

The agent calls the tool, the session goes idle, and Kimaki wakes it when the time arrives. Useful for "check back after the deploy", waiting for a nightly build, or resuming on a specific date.

```
┣ kimaki_sleep for 2h _waiting for the deploy_
```

Ask for it in plain language:

> deploy is running, check back in 2 hours and confirm it went green

The tool takes either `duration` (`30s`, `10m`, `2h`, `1d`) or `until` (UTC ISO ending with `Z`), plus an optional `reason`. When the time arrives Kimaki posts a wake message into the same thread:

```
⬦ Woke after sleeping until 2030-01-01 09:00 UTC
Reason: waiting for the deploy
Continue the work you were waiting for.
```

The wake is a new turn on the **same** session, so the agent still has its full history.

**It survives restarts.** The wake time lives in SQLite, so restarting or upgrading Kimaki does not lose a pending sleep. A sleep is only marked delivered once the wake actually starts a turn, so a crash partway through waking retries instead of losing the wait. Each wake carries an idempotency key so a retry can never wake the same session twice.

**Any new turn cancels it.** A chat message, `/queue`, `/abort`, a slash command, or a `kimaki send` prompt all supersede a pending sleep, so no stale wake arrives later. `/btw` is the exception: it forks to a side thread on purpose and leaves the wait running. Each session has at most one pending sleep.

Sleep is different from `--send-at` scheduled tasks: sleep resumes **this** conversation with full context, while a scheduled task starts a **new** prompt on a timer.

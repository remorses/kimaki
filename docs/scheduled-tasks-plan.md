---
title: Scheduled Tasks And Reminders Plan
description: Plan to add generic persisted scheduling (once/every/cron) and an unfinished follow-up reminder.
prompt: |
  put this plan in a plans md file

  Context from the thread:
  - Add support for a "mark as unfinished" tool that automatically sends a
    message in 1 hour if the user read the thread but did not respond.
  - Discord bots cannot detect read state; use lack-of-interaction instead.
  - No MCP; implement tools via the OpenCode plugin (discord/src/opencode-plugin.ts).
  - Expand to more generic reminders/tasks (once reminders, cron reminders, etc.),
    similar in spirit to OpenClaw.

  References used while planning:
  - Files read: discord/src/opencode-plugin.ts, discord/src/cli.ts,
    discord/src/discord-bot.ts, discord/src/session-handler.ts,
    discord/src/database.ts, discord/schema.prisma
  - External references: https://docs.openclaw.ai/cron-jobs
    and https://docs.clawd.bot/cli/cron
---

## Constraints / Non-Goals

- Discord bots cannot access read receipts or per-user read state; implement
  reminders based on no user interaction (no reply / reaction / button click),
  optionally using typing as a weak signal.
- Keep SQLite schema backward compatible: use additive changes and include a
  startup migration path for existing databases.

## Desired Features

- One-shot reminders ("in 20m" / "at 2026-02-01T16:00:00Z").
- Recurring reminders:
  - interval (`everyMs`)
  - cron expression (`cron`, optional timezone)
- Presets:
  - "mark as unfinished": schedule a follow-up in 60 minutes; auto-cancel if the
    user responds.
- Management:
  - list scheduled tasks for a thread/session
  - cancel scheduled tasks
  - (optional) run now for debugging

## High-Level Architecture

```text
OpenCode session (tool call)
  -> opencode-plugin tool (discord/src/opencode-plugin.ts)
    -> lock server HTTP route (discord/src/cli.ts)
      -> SQLite (Prisma) persistence
        -> scheduler loop inside discord bot (discord/src/discord-bot.ts)
          -> dispatch + send messages to thread
```

Key idea: keep the scheduler in the **bot process** (it already maintains the
Discord client). The plugin is responsible for registering tools and forwarding
requests to the bot via the lock server.

## Data Model Plan

Add a generic `scheduled_tasks` table in `discord/schema.prisma`.

Recommended shape (names can be tweaked to match existing style):

- Identity/routing
  - `id`
  - `thread_id`
  - `session_id` (optional)
  - `task_kind` (e.g. `thread-reminder`, `unfinished-followup`)
- Schedule
  - `schedule_kind`: `at | every | cron`
  - `run_at` (for one-shot)
  - `every_ms` (for interval)
  - `cron_expr`, `timezone` (for cron)
  - `next_run_at` (computed)
- Payload and behavior
  - `payload_json` (string)
  - `cancel_on_user_message` (int 0/1)
  - `delete_after_run` (int 0/1)
- Execution state
  - `status`: `pending | running | done | cancelled | failed`
  - `attempts`, `last_run_at`, `last_error`

Indexes:
- `(status, next_run_at)` for efficient polling.
- `(thread_id, status)` for cancellation.

Migration requirement:
- Update `discord/src/db.ts` migration logic so existing users get the new table
  without breaking old DBs.

## Runtime Plan

### 1) Lock Server API

Extend `startLockServer()` in `discord/src/cli.ts`:

- `POST /schedule-task`
  - validate and normalize input
  - write scheduled task to DB
  - return `{ taskId }`
- `POST /cancel-tasks`
  - cancel pending tasks for thread/session
  - return `{ cancelledCount }`
- `GET /list-tasks?threadId=...` (optional)
  - list tasks for debugging/UI

This mirrors the existing `/file-upload` bridging pattern.

### 2) OpenCode Plugin Tools

Add tools in `discord/src/opencode-plugin.ts`:

- `kimaki_mark_unfinished`
  - schedules a one-shot reminder in 60 minutes (default)
  - sets `cancel_on_user_message = true`
- `kimaki_schedule_once`
  - schedule a one-shot reminder for a thread
- `kimaki_schedule_recurring`
  - interval (`everyMs`) or cron (`expr`, `tz`)
- `kimaki_cancel_scheduled_tasks`
- `kimaki_list_scheduled_tasks`

Implementation detail:
- Each tool resolves `thread_id` via `thread_sessions` using
  `context.sessionID` (pattern already used by other tools in this file).
- Tools forward to the lock server over localhost HTTP.

### 3) Scheduler Loop

Add `discord/src/task-scheduler.ts` and start it from
`discord/src/discord-bot.ts` once the Discord client is ready.

Scheduler responsibilities:

- Poll due tasks every 15-60s.
- Claim tasks atomically: transition `pending -> running` (idempotency).
- Execute by `task_kind`:
  - `unfinished-followup`: send follow-up message into the thread
  - `thread-reminder`: send configured reminder message
- On success:
  - one-shot: mark `done` and optionally delete when `delete_after_run = true`
  - recurring: compute and set `next_run_at`, revert to `pending`
- On failure:
  - record `last_error`, bump `attempts`
  - recurring: apply exponential backoff (cap)
  - one-shot: mark `failed`

### 4) Auto-Cancel On User Response

In `discord/src/discord-bot.ts`, when a non-bot user posts a message in a
thread, cancel tasks for that thread with `cancel_on_user_message = true`.

This is the practical replacement for "user read but no response".

## Phased Delivery

Phase 1 (MVP):
- DB table + migration
- scheduler loop
- `kimaki_mark_unfinished`

Phase 2:
- `kimaki_schedule_once` + `kimaki_cancel_scheduled_tasks`

Phase 3:
- recurring interval (`everyMs`)
- recurring cron (`expr` + `tz`)

Phase 4 (nice-to-have):
- list tasks UX + "run now" debugging
- per-channel defaults, suppress duplicates, smarter cancel signals (reaction,
  button click)

## Tests / Validation

Add a new test file `discord/src/scheduled-tasks.test.ts` focusing on the
non-obvious logic:

- schedule normalization
- claiming/idempotency behavior
- cancel-on-user-message filtering
- next-run computation for `every` and `cron`
- retry/backoff rules

Validation commands:

```bash
cd discord
pnpm tsc
pnpm test --run
```

---
title: Strada product analytics for Kimaki
description: >
  How to query Kimaki install-level product analytics with the Strada CLI.
  Covers event schema, DAU/WAU/MAU, funnels, retention, completion rate,
  and breakdowns by bot mode, platform, and turn source.
---

# Strada product analytics for Kimaki

Kimaki sends **anonymous install-level** product events to Strada (OpenTelemetry logs).
No Discord IDs, paths, prompts, or secrets. Metrics count **active installs**, not people.

**Source of truth for emitters:** `cli/src/analytics.ts`

```
bot_started
     │
project_registered
     │
session_created
     │
turn_started   ◄── main activity / DAU signal
     │
turn_completed ◄── natural visible finish + duration
     │
tokens_used    ◄── billed tokens at session.idle (abort + subagents too)
```

## Projects

| Project | Slug | When to use |
|---|---|---|
| Production | `kimaki` | Published CLI installs (default project id in `analytics.ts`) |
| Local / dev | `kimaki-local` | Bot launched from this repo with `cli/.env` overrides |

```bash
# prod (default for released kimaki)
strada analytics events -p kimaki --since 7d

# local bot while developing
strada analytics events -p kimaki-local --since 7d
```

Override local ingest with `KIMAKI_STRADA_PROJECT_ID` / `KIMAKI_STRADA_TOKEN` / `KIMAKI_STRADA_ENVIRONMENT`.

**Disable analytics** (no events leave the machine):

```bash
kimaki --no-analytics
# or
KIMAKI_STRADA_ENABLED=0 kimaki
```

## Login and setup

```bash
strada login
strada whoami
strada orgs list
strada projects list
strada setup --org Personal -p kimaki   # optional folder default
```

Use `-p kimaki` or `-p kimaki-local` on every command if setup is not configured.
Login must use the Google account that owns the **Personal** org (t.de).

## Event schema

All product events use:

- **ServiceName:** `kimaki-cli`
- **Body / event name:** `LogAttributes['event.name']`
- **Install id:** `LogAttributes['custom.install_id']` (UUID in `{dataDir}/install-id`)

Common props on every event (`commonAnalyticsProps`):

| Attribute | Values |
|---|---|
| `custom.install_id` | UUID |
| `custom.schema_version` | `1` |
| `custom.bot_mode` | `gateway` \| `self_hosted` |
| `custom.platform` | `darwin` \| `linux` \| `win32` |
| `custom.arch` | `arm64` \| `x64` \| … |

Per-event props:

| Event | Extra attributes |
|---|---|
| `bot_started` | `custom.guild_count`, optional `custom.user_project_count` |
| `project_registered` | `custom.project_kind` (`user`/`default`), `custom.source` (`onboarding`/`discord_command`/`cli`/`send_auto_create`), optional `custom.user_project_count` |
| `session_created` | `custom.has_worktree`, `custom.source` (`discord`/`scheduled`) |
| `turn_started` | `custom.input_kind` (`prompt`/`command`), `custom.ingress_mode` (`direct`/`local_queue`), `custom.source` (`discord`/`cli`/`scheduled`/`retry`), `custom.uses_custom_agent` |
| `turn_completed` | `custom.duration_sec` |
| `tokens_used` | `custom.tokens_input`, `custom.tokens_output`, `custom.tokens_reasoning`, `custom.tokens_cache_read`, `custom.tokens_cache_write`, `custom.tokens_total`, `custom.cost`, `custom.assistant_message_count`, `custom.is_subagent`, optional `custom.model`, optional `custom.provider` |

**Notes:**

- `turn_completed` fires only on **natural visible** assistant completion (footer path). Aborts and empty runs do not complete.
- `tokens_used` fires on **session.idle**. It reports the billed delta since the previous idle in the same user turn, so abort races and restarts do not double-count. `custom.tokens_total` uses OpenCode `tokens.total` when present; component fields are still sent for mix analysis. Reasoning is often already inside output, so do not sum components to get billed tokens. Subagent sessions emit their own event with `custom.is_subagent = "true"`. `custom.model` / `custom.provider` are the last assistant step in that delta, not a perfect mixed-model split. Empty / zero-token idles are skipped. Do not also sum `turn_completed` for tokens.
- `custom.source = retry` on `turn_started` is internal resume traffic. Exclude it from pure product DAU if you want user-driven activity only.
- Booleans land as strings (`"true"` / `"false"`) in ClickHouse map values.
- Multiple `--data-dir` values = multiple installs.

## Quick CLI shortcuts

```bash
# top events
strada analytics events -p kimaki --since 7d -n 20

# active services
strada services list -p kimaki --since 7d

# website/server errors (same project when website secrets are set)
strada issues list -p kimaki --since 24h --status all

# ad-hoc SQL (always LIMIT; never filter ProjectId yourself)
strada query "SELECT count() AS c FROM otel_logs WHERE Timestamp >= now() - INTERVAL 1 DAY LIMIT 1" -p kimaki
```

Interactive browse: run bare `strada` for the TUI.

## Core queries

Replace `-p kimaki` with `-p kimaki-local` when inspecting the dev bot.

### Event volume

```bash
strada query "
SELECT
  LogAttributes['event.name'] AS event,
  count() AS events,
  uniqExact(LogAttributes['custom.install_id']) AS installs
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
GROUP BY event
ORDER BY events DESC
LIMIT 20
" -p kimaki
```

### DAU / turns per day

Primary activity signal is any product event. Prefer `turn_started` for intensity.

```bash
strada query "
SELECT
  toDate(Timestamp) AS day,
  uniqExact(LogAttributes['custom.install_id']) AS dau,
  countIf(
    LogAttributes['event.name'] = 'turn_started'
    AND LogAttributes['custom.source'] != 'retry'
  ) AS turns,
  round(turns / nullIf(dau, 0), 1) AS turns_per_install
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 14 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
  AND LogAttributes['custom.install_id'] != ''
GROUP BY day
ORDER BY day DESC
LIMIT 14
" -p kimaki
```

### DAU / WAU / MAU + stickiness

```bash
strada query "
SELECT
  uniqExactIf(LogAttributes['custom.install_id'], Timestamp >= now() - INTERVAL 1 DAY) AS dau,
  uniqExactIf(LogAttributes['custom.install_id'], Timestamp >= now() - INTERVAL 7 DAY) AS wau,
  uniqExactIf(LogAttributes['custom.install_id'], Timestamp >= now() - INTERVAL 30 DAY) AS mau,
  round(dau / nullIf(wau, 0), 3) AS dau_wau
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
  AND LogAttributes['custom.install_id'] != ''
LIMIT 1
" -p kimaki
```

`dau_wau` near **1.0** means almost everyone active this week was also active today (small or sticky base). Near **0.14** is closer to uniform weekday spread with little overlap.

### Activation funnel (unique installs)

```bash
strada query "
SELECT
  uniqExactIf(LogAttributes['custom.install_id'], LogAttributes['event.name'] = 'bot_started') AS bots,
  uniqExactIf(LogAttributes['custom.install_id'], LogAttributes['event.name'] = 'project_registered') AS projects,
  uniqExactIf(LogAttributes['custom.install_id'], LogAttributes['event.name'] = 'session_created') AS sessions,
  uniqExactIf(LogAttributes['custom.install_id'], LogAttributes['event.name'] = 'turn_started') AS turned,
  uniqExactIf(LogAttributes['custom.install_id'], LogAttributes['event.name'] = 'turn_completed') AS completed
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
LIMIT 1
" -p kimaki
```

### Turn completion rate and duration

```bash
strada query "
SELECT
  countIf(
    LogAttributes['event.name'] = 'turn_started'
    AND LogAttributes['custom.source'] != 'retry'
  ) AS started,
  countIf(LogAttributes['event.name'] = 'turn_completed') AS completed,
  round(completed / nullIf(started, 0), 3) AS completion_rate,
  round(avgIf(
    toFloat64OrZero(LogAttributes['custom.duration_sec']),
    LogAttributes['event.name'] = 'turn_completed'
  ), 1) AS avg_sec,
  round(quantileIf(0.5)(
    toFloat64OrZero(LogAttributes['custom.duration_sec']),
    LogAttributes['event.name'] = 'turn_completed'
  ), 1) AS p50_sec,
  round(quantileIf(0.9)(
    toFloat64OrZero(LogAttributes['custom.duration_sec']),
    LogAttributes['event.name'] = 'turn_completed'
  ), 1) AS p90_sec
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 7 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
LIMIT 1
" -p kimaki
```

Completion is intentionally **success-shaped**: only clean visible finishes. A low rate can mean aborts, crashes, or long in-flight turns, not only failures.

### Platform and bot mode mix

```bash
strada query "
SELECT
  LogAttributes['custom.bot_mode'] AS bot_mode,
  LogAttributes['custom.platform'] AS platform,
  LogAttributes['custom.arch'] AS arch,
  uniqExact(LogAttributes['custom.install_id']) AS installs,
  countIf(LogAttributes['event.name'] = 'turn_started') AS turns
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
GROUP BY bot_mode, platform, arch
ORDER BY turns DESC
LIMIT 20
" -p kimaki
```

### Turn breakdown (source / input / queue / agent)

```bash
strada query "
SELECT
  LogAttributes['custom.source'] AS source,
  LogAttributes['custom.input_kind'] AS input_kind,
  LogAttributes['custom.ingress_mode'] AS ingress_mode,
  LogAttributes['custom.uses_custom_agent'] AS custom_agent,
  count() AS turns
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 7 DAY
  AND ServiceName = 'kimaki-cli'
  AND LogAttributes['event.name'] = 'turn_started'
GROUP BY source, input_kind, ingress_mode, custom_agent
ORDER BY turns DESC
LIMIT 30
" -p kimaki
```

### Project registration sources

```bash
strada query "
SELECT
  LogAttributes['custom.project_kind'] AS project_kind,
  LogAttributes['custom.source'] AS source,
  count() AS events,
  uniqExact(LogAttributes['custom.install_id']) AS installs
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND LogAttributes['event.name'] = 'project_registered'
GROUP BY project_kind, source
ORDER BY events DESC
LIMIT 20
" -p kimaki
```

### Sessions and worktrees

```bash
strada query "
SELECT
  LogAttributes['custom.source'] AS source,
  LogAttributes['custom.has_worktree'] AS has_worktree,
  count() AS sessions,
  uniqExact(LogAttributes['custom.install_id']) AS installs
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND LogAttributes['event.name'] = 'session_created'
GROUP BY source, has_worktree
ORDER BY sessions DESC
LIMIT 20
" -p kimaki
```

### Power installs (top users by turns)

```bash
strada query "
SELECT
  LogAttributes['custom.install_id'] AS install_id,
  countIf(LogAttributes['event.name'] = 'turn_started') AS turns,
  countIf(LogAttributes['event.name'] = 'session_created') AS sessions,
  countIf(LogAttributes['event.name'] = 'turn_completed') AS completed,
  min(Timestamp) AS first_seen,
  max(Timestamp) AS last_seen
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
  AND LogAttributes['custom.install_id'] != ''
GROUP BY install_id
ORDER BY turns DESC
LIMIT 20
" -p kimaki
```

### Total token usage

`tokens_used` is the event to sum. Each row is one session run (main turn or subagent) becoming idle.

```bash
strada query "
SELECT
  sum(toFloat64OrZero(LogAttributes['custom.tokens_input'])) AS input,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_output'])) AS output,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_reasoning'])) AS reasoning,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_cache_read'])) AS cache_read,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_cache_write'])) AS cache_write,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_total'])) AS total,
  sum(toFloat64OrZero(LogAttributes['custom.cost'])) AS cost,
  uniqExact(LogAttributes['custom.install_id']) AS installs
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND LogAttributes['event.name'] = 'tokens_used'
LIMIT 1
" -p kimaki
```

### Token usage by model

```bash
strada query "
SELECT
  LogAttributes['custom.provider'] AS provider,
  LogAttributes['custom.model'] AS model,
  LogAttributes['custom.is_subagent'] AS is_subagent,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_total'])) AS tokens,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_input'])) AS input,
  sum(toFloat64OrZero(LogAttributes['custom.tokens_output'])) AS output,
  count() AS runs
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 30 DAY
  AND ServiceName = 'kimaki-cli'
  AND LogAttributes['event.name'] = 'tokens_used'
GROUP BY provider, model, is_subagent
ORDER BY tokens DESC
LIMIT 30
" -p kimaki
```

## Retention

Identity is `custom.install_id`. Cohort day = first day that install emitted any product event.

### Classic D1 / D7 retention by cohort day

An install is retained on **D1** if it is active again on **exactly** cohort day + 1 (same for D7).

```bash
strada query "
SELECT
  cohort_day,
  count() AS cohort_size,
  countIf(has_d1) AS d1,
  countIf(has_d7) AS d7,
  round(d1 / nullIf(cohort_size, 0), 3) AS d1_rate,
  round(d7 / nullIf(cohort_size, 0), 3) AS d7_rate
FROM (
  SELECT
    c.install_id AS install_id,
    c.cohort_day AS cohort_day,
    countIf(a.day = c.cohort_day + 1) > 0 AS has_d1,
    countIf(a.day = c.cohort_day + 7) > 0 AS has_d7
  FROM (
    SELECT
      LogAttributes['custom.install_id'] AS install_id,
      min(toDate(Timestamp)) AS cohort_day
    FROM otel_logs
    WHERE Timestamp >= now() - INTERVAL 60 DAY
      AND ServiceName = 'kimaki-cli'
      AND mapContains(LogAttributes, 'event.name')
      AND LogAttributes['custom.install_id'] != ''
    GROUP BY install_id
  ) AS c
  INNER JOIN (
    SELECT
      LogAttributes['custom.install_id'] AS install_id,
      toDate(Timestamp) AS day
    FROM otel_logs
    WHERE Timestamp >= now() - INTERVAL 60 DAY
      AND ServiceName = 'kimaki-cli'
      AND mapContains(LogAttributes, 'event.name')
      AND LogAttributes['custom.install_id'] != ''
    GROUP BY install_id, day
  ) AS a ON c.install_id = a.install_id
  GROUP BY c.install_id, c.cohort_day
)
GROUP BY cohort_day
ORDER BY cohort_day DESC
LIMIT 30
" -p kimaki
```

### Weekly cohort stickiness

Compare **dates**, not raw DateTime + integer (ClickHouse treats `DateTime + N` as **seconds**).

```bash
strada query "
SELECT
  toStartOfWeek(first_day) AS cohort_week,
  count() AS installs,
  countIf(last_day > first_day) AS returned_later,
  countIf(last_day >= first_day + 7) AS active_after_7d,
  round(avg(turns), 1) AS avg_turns
FROM (
  SELECT
    LogAttributes['custom.install_id'] AS install_id,
    min(toDate(Timestamp)) AS first_day,
    max(toDate(Timestamp)) AS last_day,
    countIf(LogAttributes['event.name'] = 'turn_started') AS turns
  FROM otel_logs
  WHERE Timestamp >= now() - INTERVAL 60 DAY
    AND ServiceName = 'kimaki-cli'
    AND mapContains(LogAttributes, 'event.name')
    AND LogAttributes['custom.install_id'] != ''
  GROUP BY install_id
)
GROUP BY cohort_week
ORDER BY cohort_week DESC
LIMIT 12
" -p kimaki
```

### Rolling retained installs (active in last 7d among installs first seen 8-30d ago)

Useful when daily cohorts are still small.

```bash
strada query "
SELECT
  count() AS mature_installs,
  countIf(last_day >= today() - 7) AS active_last_7d,
  round(active_last_7d / nullIf(mature_installs, 0), 3) AS retained_rate
FROM (
  SELECT
    LogAttributes['custom.install_id'] AS install_id,
    min(toDate(Timestamp)) AS first_day,
    max(toDate(Timestamp)) AS last_day
  FROM otel_logs
  WHERE Timestamp >= now() - INTERVAL 60 DAY
    AND ServiceName = 'kimaki-cli'
    AND mapContains(LogAttributes, 'event.name')
    AND LogAttributes['custom.install_id'] != ''
  GROUP BY install_id
)
WHERE first_day <= today() - 8
  AND first_day >= today() - 30
LIMIT 1
" -p kimaki
```

## Hourly activity (ops / load shape)

```bash
strada query "
SELECT
  toStartOfHour(Timestamp) AS hour,
  countIf(LogAttributes['event.name'] = 'turn_started') AS turns,
  countIf(LogAttributes['event.name'] = 'session_created') AS sessions,
  uniqExact(LogAttributes['custom.install_id']) AS installs
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 2 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
GROUP BY hour
ORDER BY hour DESC
LIMIT 48
" -p kimaki
```

## Recent raw events (debug)

```bash
strada query "
SELECT
  Timestamp,
  LogAttributes['event.name'] AS event,
  LogAttributes['custom.install_id'] AS install_id,
  LogAttributes['custom.source'] AS source,
  LogAttributes['custom.input_kind'] AS input_kind,
  LogAttributes['custom.ingress_mode'] AS ingress_mode,
  LogAttributes['custom.duration_sec'] AS duration_sec,
  LogAttributes['custom.bot_mode'] AS bot_mode,
  LogAttributes['custom.platform'] AS platform
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 1 DAY
  AND ServiceName = 'kimaki-cli'
  AND mapContains(LogAttributes, 'event.name')
ORDER BY Timestamp DESC
LIMIT 50
" -p kimaki
```

## SQL rules (Strada / Tinybird)

- **Never** add `WHERE ProjectId = ...`. JWT scopes the project.
- Always add **`LIMIT`**.
- Column names are **PascalCase** (`Timestamp`, `ServiceName`, `LogAttributes`).
- Map access: `LogAttributes['custom.install_id']`, existence via `mapContains(...)`.
- Prefer **subqueries** over CTEs.
- Filter time with `Timestamp >= now() - INTERVAL N DAY`.
- For day math use `toDate(...)` and `Date + N` (days). Do not add integers to `DateTime` unless you mean seconds.

## What this can and cannot answer

**Can answer well**

- Active installs (DAU/WAU/MAU)
- Turns per install and completion rate
- Total billed tokens across all installs (`tokens_used`)
- Token mix by model / provider / cache vs output
- Gateway vs self-hosted share
- OS / arch mix
- Discord vs CLI vs scheduled traffic
- Whether projects and sessions are being created
- D1/D7 retention once enough calendar days exist

**Cannot answer yet**

- Exact agent name (only `uses_custom_agent` boolean)
- Why a turn failed (no abort/error product event)
- Version-over-version comparisons (version is on the OTel resource, not always on event props)
- Website conversion funnels (website currently reports errors, not product events)

## Implementation map

| Concern | File |
|---|---|
| Emit helpers | `cli/src/analytics.ts` |
| `bot_started` | `cli/src/discord-bot.ts` |
| `project_registered` | `cli/src/channel-management.ts` |
| `session_created` / turns / `tokens_used` | `cli/src/session-handler/thread-session-runtime.ts` |
| CLI short-path init/flush | `cli/src/cli-commands/project.ts`, `send.ts`, `cli-runner.ts` |
| Website errors | `website/src/strada-init.ts`, `website/src/strada-browser.tsx` |

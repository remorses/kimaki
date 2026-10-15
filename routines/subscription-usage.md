---
title: Subscription allowance before weekly reset
description: >
  Managed by two Kimaki routines, one for Claude and one for OpenAI.
  Do not move or delete this file without updating those routines with
  kimaki routine list / kimaki routine edit.
---

# Subscription allowance before weekly reset

The scheduled prompt specifies **Claude** or **OpenAI**. Report for that provider.
Load the global `subscription-usage` skill and follow it. Run the real network SDK:

```bash
bun ~/.config/opencode/skills/subscription-usage/sdk.ts
```

## Timing

- These reminders belong in channel `1422625308523102348`, 48 hours before each
  provider's weekly reset. Use `weekly_all` for Claude and `Plan` for OpenAI.
- Use the live `resetsAt`, never stale history. Check `daysUntilReset`.
- If the live reset moved, find this provider's routine with `kimaki routine list`
  and edit its existing weekly cron to the UTC reset minus 48 hours.
  Never create a second routine for that provider or touch unrelated routines.
- If more than 49 hours remain, correct the schedule and do not send an early
  consumption reminder. If less than 47 hours remain, report honestly that the
  reminder is late and correct future timing. The initial Claude check was already
  inside the two-day window when these routines were created.

## Report

Mention `<@535922349652836367>` after reading live data. Keep the message short:

1. **Available now:** `remainingPercent` of weekly allowance.
2. **Expected unused at reset:** `projectedUnusedPercentAtReset`, assuming the
   current-week average continues. Call this a projection, not a guarantee.
3. Show the average in percentage points/day and `remainingPercentagePointsPerDay`
   needed to use the remaining allowance before reset.
4. Show the reset date/time in UTC and Europe/Rome.
5. If at least 10% is projected unused, suggest bringing forward useful queued
   work, such as code reviews, bug investigations, or documentation. If less than
   10% remains projected unused, suggest keeping the normal pace. If projected use
   exceeds 100%, warn that the weekly limit may be reached before reset.

Example wording, with live values substituted:

> You have 40% left. At your current pace, about 20% will expire unused.
> Bring forward useful backlog work over the next two days if you want to use it.

## Claude promotional and API credits

For the Claude report, also show `cloudSessionCredits` remaining dollars,
percentage, and expiration. Explain these are **cloud-session credits**, not
API-key credits, and their expiry is separate from the weekly reset.

Show `apiCreditsUnavailableReason` as "Separate API credit balance not verified".
Never claim the API balance is zero or that the cloud credit funds API calls.
No API key for these cloud credits was created or stored in Sigillo by this task.

## Limits

- Do not show five-hour limits or raw tokens, secrets, API keys, or authentication.
- Do not spend, buy credits, activate resets, change billing or auto-reload, create
  API keys, edit Sigillo, or start backlog tasks automatically.
- Historical OpenAI averages are supplementary and may have different scope.
  Base the unused-at-reset projection on the live current-week average.
- If Chrome, login, or an endpoint is unavailable, mention Tommy and report the
  failure in a callout. Do not substitute old data or silently skip the reminder.
- The host computer and signed-in Chrome must be available for live network data.

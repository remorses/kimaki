---
title: CI & Automation
description: Start Kimaki sessions from CI pipelines, cron jobs, or any automation. Includes GitHub Actions examples, scheduled tasks, and per-session permissions.
---

# CI & Automation

## Programmatically Start Sessions

The `send` command creates a Discord thread with your prompt, and the running bot on your machine picks it up automatically.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `KIMAKI_BOT_TOKEN` | Yes (in CI) | Discord bot token |

### CLI Options

```bash
npx -y kimaki send \
  --channel <channel-id>    # Required: Discord channel ID
  --prompt <prompt>         # Required: Message content
  --name <name>             # Optional: Thread name (defaults to prompt preview)
  --app-id <app-id>         # Optional: Bot application ID for validation
  --notify-only             # Optional: Create notification thread without starting AI session
  --worktree <name>         # Optional: Create git worktree for isolated session
  --thread <thread-id>      # Optional: Send prompt to existing thread (no new thread)
  --session <session-id>    # Optional: Resolve thread from session and send prompt
  --permission <rule>       # Optional: Repeatable. Per-session permission rule (see below)
```

Use either `--channel/--project` (create new thread) or `--thread/--session` (send to existing thread), not both.

### Example: GitHub Actions on New Issues

This workflow starts a Kimaki session whenever a new issue is opened:

```yaml
# .github/workflows/investigate-issues.yml
name: Investigate New Issues

on:
  issues:
    types: [opened]

jobs:
  investigate:
    runs-on: ubuntu-latest
    steps:
      - name: Start Kimaki Session
        env:
          KIMAKI_BOT_TOKEN: ${{ secrets.KIMAKI_BOT_TOKEN }}
        run: |
          npx -y kimaki send \
            --channel "1234567890123456789" \
            --prompt "Investigate issue ${{ github.event.issue.html_url }} using gh cli. Try fixing it in a new worktree ./${{ github.event.issue.number }}" \
            --name "Issue #${{ github.event.issue.number }}"
```

**Setup:**

1. Add `KIMAKI_BOT_TOKEN` to your repository secrets (Settings > Secrets > Actions)
2. Replace `1234567890123456789` with your Discord channel ID (right-click channel > Copy Channel ID)
3. Make sure the Kimaki bot is running on your machine

### How It Works

1. **CI runs `send`** — Creates a Discord thread with your prompt
2. **Running bot detects thread** — Automatically starts a session
3. **Bot starts OpenCode session** — Uses the prompt from the thread
4. **AI investigates** — Runs on your machine with full codebase access

Use `--notify-only` for notifications that don't need immediate AI response (e.g., subscription events). Reply to the thread later to start a session with the notification as context.

## Add Project Channels

Create Discord channels for a project directory without starting a session:

```bash
# Add current directory as a project
npx -y kimaki project add

# Add a specific directory
npx -y kimaki project add /path/to/project

# Specify guild when bot is in multiple servers
npx -y kimaki project add ./myproject --guild 123456789

# In CI with env var for bot token
KIMAKI_BOT_TOKEN=xxx npx -y kimaki project add --app-id 987654321
```

| Option | Description |
|---|---|
| `[directory]` | Project directory path (defaults to current directory) |
| `-g, --guild <guildId>` | Discord guild/server ID (auto-detects if bot is in only one server) |
| `-a, --app-id <appId>` | Bot application ID (reads from database if available) |

## Scheduled Tasks

Add `--send-at` to any `kimaki send` command to schedule it for later. Supports one-time ISO dates (must be UTC ending with `Z`) and recurring cron expressions:

```bash
# One-time: run at a specific UTC time
kimaki send --channel <channel-id> --prompt "Review open PRs" \
  --send-at "2026-03-01T09:00:00Z"

# Recurring: every Monday at 9am UTC
kimaki send --channel <channel-id> \
  --prompt "Run weekly test suite and summarize failures" \
  --send-at "0 9 * * 1"

# Schedule a reminder into an existing thread
kimaki send --session <session-id> \
  --prompt "Reminder: <@user-id> check back on this thread" \
  --send-at "2026-03-01T15:00:00Z" --notify-only
```

All other `send` flags (`--notify-only`, `--worktree`, `--agent`, `--model`, `--user`) work with `--send-at`. The only exception is `--wait`, which is incompatible since the task runs in the future.

Manage scheduled tasks with `kimaki task list` and `kimaki task delete <id>`.

## Per-Session Permissions

When starting sessions with `kimaki send`, you can restrict tools for that specific session using `--permission`. Useful for CI pipelines, scheduled tasks, or spawning sandboxed sessions.

Format: `tool:action` or `tool:pattern:action`. Actions: `allow`, `deny`, `ask`.

```bash
# Read-only session (no edits, no bash)
kimaki send -c 123 -p "Review this code" \
  --permission "bash:deny" \
  --permission "edit:deny"

# Only allow git commands
kimaki send -c 123 -p "Check git history" \
  --permission "bash:git *:allow" \
  --permission "bash:*:deny"

# Deny everything except reading
kimaki send -c 123 -p "Analyze the codebase" \
  --permission "*:deny" \
  --permission "read:allow" \
  --permission "glob:allow" \
  --permission "grep:allow"
```

Rules are evaluated with `findLast()` — later rules override earlier ones. The `--permission` flag works with `--send-at` (scheduled tasks) and `--thread`/`--session` (existing threads) too.

See the full [OpenCode Permissions documentation](https://opencode.ai/docs/permissions/) for all available permissions, granular pattern matching, and per-agent overrides.

---
name: zele
description: >
  Control Gmail and Google Calendar via CLI. Read, search, send, reply, and forward
  emails. Create, update, and delete calendar events. Manage drafts, labels, and attachments.
  Supports multiple Google accounts. Use this skill whenever the user asks to check email,
  send messages, schedule meetings, or manage their calendar.
---

# zele — Gmail & Google Calendar CLI

A multi-account Gmail and Google Calendar client. Output is YAML, pipe-friendly.

## Setup

```bash
# install (requires bun)
bun install -g zele

# show connected accounts
zele whoami

# authenticate (opens browser, supports multiple accounts)
zele login
```

**Remote/headless login:** `zele login` is interactive — it prints an authorization URL and waits for a redirect URL to be pasted back. In agent/headless environments, run it inside tmux so the process persists:

```bash
# start login in a tmux session
tmux new-session -d -s zele-login 'zele login'

# read the authorization URL from tmux output
tmux capture-pane -t zele-login -p

# after the user completes consent in their browser, paste the redirect URL
tmux send-keys -t zele-login 'http://localhost:...?code=...' Enter

# verify login succeeded
tmux capture-pane -t zele-login -p
tmux kill-session -t zele-login
```

## Important

**Always run `zele --help` before using.** The help output is the source of truth for all commands, options, and syntax. Run `zele <command> --help` for subcommand details (e.g. `zele mail send --help`). NEVER use head to truncate the output. read it fully.

Running `zele` with no subcommand launches a human-friendly TUI for browsing email. **Agents should not use the TUI** — always use the CLI subcommands (`zele mail list`, `zele cal events`, etc.) which output structured YAML.

## Capabilities

- **Mail:** list, search, read, send, reply, forward, star, archive, trash, label, watch for new emails, manage filters
- **Drafts:** list, create, get, send, delete
- **Calendar:** list calendars, list/search events, create/update/delete events, RSVP, free/busy
- **Labels:** list, create, delete, unread counts
- **Attachments:** list per thread, download
- **Multi-account:** all commands support `--account <email>` to filter; list/search merge across accounts

## Account discovery

When the user asks to check emails **for a specific account** (e.g. "check my work email", "what's new on my personal Gmail?"), always run `zele whoami` first to list the connected accounts and find the exact email address to pass to `--account`. Never guess the email — use the output of `zele whoami` to pick the right one.

```bash
# list connected accounts
zele whoami

# then use the email from the output
zele mail list --account user@work.com
```

## Examples

```bash
# list inbox
zele mail list

# search mail
zele mail search "from:github subject:review"

# read a thread (thread IDs come from list/search output)
zele mail read <threadId>

# send an email with attachment
zele mail send --to alice@example.com --subject "Report" --body "See attached" --attach report.pdf

# reply all
zele mail reply <threadId> --body "Thanks!" --all

# watch inbox for new mail (polls every 15s)
zele mail watch

# today's calendar events across all accounts
zele cal events --today --all

# create a meeting with Google Meet
zele cal create --summary "Standup" --from tomorrow --to +30m --meet --attendees bob@example.com

# check free/busy
zele cal freebusy --from today --to +8h

# list Gmail filters
zele mail filter list
```

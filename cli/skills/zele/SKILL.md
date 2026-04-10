---
name: zele
description: >
  Control Gmail and Google Calendar via CLI. Read, search, send, reply, and forward
  emails. Create, update, and delete calendar events. Manage drafts, labels, and attachments.
  Supports multiple Google accounts and IMAP/SMTP accounts (Fastmail, Outlook, any provider).
  Use this skill whenever the user asks to check email, send messages, schedule meetings,
  or manage their calendar.
---

# zele — Email & Calendar CLI

A multi-account email and calendar client supporting **Google OAuth** and **IMAP/SMTP** (Fastmail, Outlook, any provider). Output is YAML, pipe-friendly.

## Setup

```bash
# install (requires bun)
bun install -g zele

# show connected accounts
zele whoami

# authenticate with Google (opens browser, supports multiple accounts)
zele login

# authenticate with IMAP/SMTP (non-interactive, designed for agents)
zele login imap \
  --email you@fastmail.com \
  --imap-host imap.fastmail.com --imap-port 993 \
  --smtp-host smtp.fastmail.com --smtp-port 465 \
  --password "your-app-password"
```

**IMAP/SMTP login options:** `--imap-user` / `--smtp-user` if the login username differs from email. Omit `--smtp-host` for read-only (no sending). Use `--imap-password` / `--smtp-password` for separate credentials.

**Remote/headless Google login:** `zele login` is interactive — it prints an authorization URL and waits for a redirect URL to be pasted back. In agent/headless environments, run it inside tmux so the process persists:

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

- **Mail:** list, search, read, send, reply, forward, star, archive, trash, watch for new emails (Google + IMAP)
- **Drafts:** list, create, get, send, delete (Google + IMAP)
- **Attachments:** list per thread, download (Google + IMAP)
- **Labels:** list, create, delete, unread counts (Google only)
- **Filters:** list server-side filters (Google only)
- **Calendar:** list calendars, list/search events, create/update/delete events, RSVP, free/busy (Google only)
- **Multi-account:** all commands support `--account <email>` to filter; list/search merge across all account types

## Account discovery

When the user asks to check emails **for a specific account** (e.g. "check my work email", "what's new on my personal Gmail?"), always run `zele whoami` first to list the connected accounts and find the exact email address to pass to `--account`. Never guess the email — use the output of `zele whoami` to pick the right one. The output also shows account type (`google` or `imap_smtp`) and capabilities.

```bash
# list connected accounts
zele whoami

# then use the email from the output
zele mail list --account user@work.com
```

## Google-only features

These commands only work with Google accounts. IMAP/SMTP accounts show a helpful error:

- `zele label list/counts/create/delete` — IMAP uses folders, not labels
- `zele mail label` — adding/removing labels
- `zele mail filter list` — server-side Gmail filters
- `zele cal *` — calendar requires Google OAuth
- `zele profile` — shows limited info for IMAP (email only, no message counts)

## IMAP search support

IMAP accounts support a subset of Gmail query syntax, translated to IMAP SEARCH:

`from:`, `to:`, `subject:`, `is:unread`, `is:starred`, `has:attachment`, `newer_than:Nd`, `older_than:Nm`, `after:YYYY/MM/DD`, `before:YYYY/MM/DD`

Unsupported on IMAP: `cc:`, `-` (negate), `label:`, `in:`, `filename:`, `size:`/`larger:`/`smaller:`, `OR`, `{ }`.

## Examples

```bash
# list inbox
zele mail list

# list only unread emails
zele mail list --filter "is:unread"

# list emails from last 7 days (works for both Google and IMAP)
zele mail list --filter "newer_than:7d"

# combine filter with folder
zele mail list --filter "from:github" --folder sent

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

# add an IMAP account (non-interactive, for agents)
zele login imap --email you@fastmail.com --imap-host imap.fastmail.com --smtp-host smtp.fastmail.com --password "app-pass"

# today's calendar events (Google only)
zele cal events --today --all

# create a meeting with Google Meet (Google only)
zele cal create --summary "Standup" --from tomorrow --to +30m --meet --attendees bob@example.com

# list Gmail filters (Google only)
zele mail filter list
```

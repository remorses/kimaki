---
name: zele
description: >
  zele is a multi-account email and calendar CLI for Gmail, IMAP/SMTP
  (Fastmail, Outlook, any provider), and Google Calendar. It reads,
  searches, sends, replies, forwards, archives, stars, and trashes emails,
  manages drafts, labels, attachments, and Gmail filters, and creates,
  updates, and deletes calendar events with RSVP and free/busy support.
  Output is YAML so commands can be piped through yq and xargs. ALWAYS
  load this skill when the user asks to check email, read/send messages,
  reply or forward, archive or trash threads, manage drafts or labels,
  download attachments, schedule meetings, check their calendar, RSVP
  to events, or when they run any `zele` command. Load it before writing
  any code or shell commands that touch zele so you know the correct
  subcommand structure, the Google vs IMAP feature matrix, the headless
  login flow, and the agent-specific rules.
---

# zele

Every time you use zele, you MUST fetch the latest README:

```bash
curl -s https://raw.githubusercontent.com/remorses/zele/main/README.md # NEVER pipe to head/tail, read the full output
```

Then run the CLI help once — it already includes every subcommand, option, and flag:

```bash
zele --help # NEVER pipe to head/tail, read the full output
```

The README and `zele --help` output are the source of truth for commands, options, flags, the Google vs IMAP feature matrix, search operators, and the headless login flow.

## Rules

1. **Never use the TUI.** Running `zele` with no subcommand launches a human-facing TUI. Agents must use the CLI subcommands (`zele mail list`, `zele cal events`, etc.) which output structured YAML.
2. **Always run `zele whoami` first** when the user asks to operate on a specific account. Pick the exact email from the output and pass it with `--account`. Never guess account emails.
3. **Never truncate `--help` or README output** with `head`, `tail`, `sed`, `awk`, or `less`. Critical rules are spread throughout. Read them in full.
4. **Parse YAML output with `yq`**, not regex. Pipe IDs through `xargs` for bulk actions. Always use `--limit 100` (or higher) so you don't miss threads:
   ```bash
   # read all unread emails
   zele mail list --filter "is:unread" --limit 100 | yq '.[].id' | xargs zele mail read

   # bulk archive
   zele mail list --filter "is:unread" --limit 100 | yq '.[].id' | xargs zele mail archive
   ```
5. **Google-only features** (labels, Gmail filters, `zele cal *`, full profile) fail on IMAP accounts with a clear error. Check `zele whoami` output for account type before using them.
6. **Headless Google login** requires a `tuistory` session because `zele login` is interactive. Launch it with `tuistory launch "zele login" -s zele-login`, inspect the prompt with `snapshot` or `read`, then paste the callback URL with `type` and `press enter`. See the README "Remote / headless login" section for the exact flow.

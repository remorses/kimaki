---
'kimaki': minor
---

Add `kimaki session abort` command and print session ID from `kimaki send`.

**`kimaki session abort <session_id>`** stops a running session without archiving the thread. The thread stays visible in Discord so you can inspect what happened. A "Session aborted via CLI" message is posted in the thread. Use this when you fire off a `kimaki send` and immediately realize the prompt was wrong.

```bash
kimaki send --channel 123 --prompt 'wrong stuff'
# Output:
# Session: ses_abc123
# https://discord.com/channels/...

kimaki session abort ses_abc123
```

**`kimaki send` now prints the session ID** alongside the thread URL. For new threads, the CLI polls the database for up to 15 seconds waiting for the bot to create the session. For existing threads, the session ID is looked up immediately. The session ID appears in both the human-readable note and the machine-readable stdout output.

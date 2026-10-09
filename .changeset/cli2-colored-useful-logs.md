---
'kimaki': patch
---

Bot logs are easier to read and more useful.

```
●  12:03:44  MAIN        bot ready as Kimaki#1234 in 2 server(s)
│  12:03:51  INGRESS     steer from tommy in thread 1557795126569476209, 1 file(s)
│  12:03:51  EVENTS      run started in thread 1557795126569476209 (ses_ee39ba467ff)
│  12:06:21  EVENTS      run finished in thread 1557795126569476209 (ses_ee39ba467ff) after 2m 30s, anthropic/claude-opus-4-6, 81234 tokens
▲  12:06:22  EFFECTS     send failed in 1557795126569476209: Discord send failed: Missing Permissions
```

- Terminal logs use clack-style symbols and colors: a color per module, yellow warnings, red errors, dimmed IDs.
- Errors show their full cause chain (`Discord send failed: Missing Permissions` instead of only `Discord send failed`). Error-level lines also print the stack of the root cause.
- New lines for every incoming message and for the start, end, failure and retries of each run, with duration, model and tokens.
- `kimaki.log` keeps plain lines without colors. Lines are written in order and reach the disk before a crash.
- Crashes are written to `kimaki.log`. A restart moves the previous run to `kimaki.previous.log`, so the crash reason survives.
- The agent system prompt explains how to read `kimaki.log` and the OpenCode service log (`~/.local/share/opencode/log/opencode.log`), so Kimaki can debug itself while running.

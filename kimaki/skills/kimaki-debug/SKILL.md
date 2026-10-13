---
name: kimaki-debug
description: Debug and administer Kimaki itself. Use when sessions do not respond, the bot shows errors, you need the Kimaki or OpenCode service logs, want to profile the bot, restart it (only when asked), connect a model provider with `kimaki login`, check who may use the bot, or file a Kimaki bug report. ALWAYS load when Kimaki misbehaves or before filing a Kimaki issue. Only for Kimaki Discord sessions.
---

# Debugging Kimaki

Read the logs before guessing. Do not restart the bot (`kimaki restart`) unless the user explicitly asks.

## Kimaki bot log

`$KIMAKI_DATA_DIR/kimaki.log` holds only the current bot run. The run before the last restart (with the crash that caused it) is in `kimaki.previous.log`. Lines are `<ISO time> <LEVEL> [<MODULE>] <message>` and errors include their cause chain. It logs incoming messages, run start/finish/failure per thread and session, Discord and OpenCode errors, routines and crashes.

```bash
tail -n 200 $KIMAKI_DATA_DIR/kimaki.log
grep -E ' (WARN|ERROR) ' $KIMAKI_DATA_DIR/kimaki.log | tail -n 50
grep '<thread_id or ses_id>' $KIMAKI_DATA_DIR/kimaki.log
```

## OpenCode service log

The shared `opencode serve --service` daemon appends to `~/.local/share/opencode/log/opencode.log` (`$XDG_DATA_HOME/opencode/log`; `opencode debug paths` prints the folder). The file is never reset and can be very large: use `tail` or `grep`, never read it whole. Lines are logfmt. `run=<id>` is one daemon process, so filter by the run of the last line. The daemon pid and URL are in `~/.local/state/opencode/service.json`.

```bash
LOG=~/.local/share/opencode/log/opencode.log
RUN=$(tail -n 1 $LOG | grep -o 'run=[a-z0-9]*')
grep "$RUN " $LOG | grep -E '^timestamp=[^ ]+ level=(ERROR|WARN)' | tail -n 50
grep "$RUN " $LOG | grep '<ses_id>' | tail -n 100
```

## Other tools

- `kimaki session events <id>` prints the recorded OpenCode events of a thread as JSONL.
- `kimaki restart` restarts the bot (only when asked). Sessions keep running in OpenCode.
- `kimaki profile cpu --duration 30s` and `kimaki profile heap` print the profile file path.
- `kimaki login PROVIDER` lists login methods of a provider. `--key` connects an API key, `--method` starts OAuth, `--attempt` checks or completes an attempt. Credentials belong to OpenCode.

## Who can use the bot

Only users with one of these Discord permissions can message the bot: Server Owner, Administrator, Manage Server, or the "Kimaki" role (case-insensitive). Other Discord bots are ignored; assign a bot the "Kimaki" role to let it trigger sessions (multi-agent orchestration).

## Reporting a bug

ALWAYS read https://kimaki.dev/docs/guides/report-bugs first. That page is the source of truth for exporting session JSONL, sharing evidence in a gist and filing bugs. Never open a pull request on remorses/kimaki unless remorses asked for one in a comment on the issue.

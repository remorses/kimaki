---
title: Internals
description: How Kimaki works under the hood — SQLite, lock port, channel metadata, voice processing, and more.
---

# Internals

**SQLite Database** — Kimaki stores state in `<data-dir>/discord-sessions.db` (default: `~/.kimaki/discord-sessions.db`). This maps Discord threads to OpenCode sessions, channels to directories, and stores your bot credentials. Use `--data-dir` to change the location.

**Lock Port** — Kimaki enforces single-instance behavior by binding a lock port. By default, the port is derived from `--data-dir`; set `KIMAKI_LOCK_PORT=<port>` to override it when running an additional Kimaki process on the same machine.

**OpenCode Servers** — When you message a channel, Kimaki spawns (or reuses) an OpenCode server for that project directory. The server handles the actual AI coding session.

**Channel Metadata** — Each channel's topic contains XML metadata linking it to a directory and bot:

```xml
<kimaki><directory>/path/to/project</directory><app>bot_id</app></kimaki>
```

**Voice Processing** — Voice features run in a worker thread. Audio flows: Discord Opus > Decoder > Downsample (48kHz to 16kHz) > Gemini API > Response > Upsample > Opus > Discord.

**Log File** — Kimaki writes logs to `<data-dir>/kimaki.log` (default: `~/.kimaki/kimaki.log`). The log file is reset on every bot startup, so it only contains logs from the current run. Read this file to debug internal issues, session failures, or unexpected behavior.

**Graceful Restart** — Send `SIGUSR2` to restart the bot with new code without losing connections.

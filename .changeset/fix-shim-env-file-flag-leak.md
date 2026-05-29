---
'kimaki': patch
---

Fix the generated `kimaki` command shim aborting with `.env: not found` when launched from a directory without a `.env` file.

The relocatable shim at `~/.kimaki/bin/kimaki` is placed on `PATH` for OpenCode child processes and runs from arbitrary working directories. When the bot was started with a relative `--env-file=.env` flag, that flag leaked into the shim's `exec` line and made Node abort whenever the current directory had no `.env`. The shim now strips `--env-file` / `--env-file-if-exists` flags (both `--flag=value` and `--flag value` forms) since the env vars the bot needs are already inherited from the process environment.

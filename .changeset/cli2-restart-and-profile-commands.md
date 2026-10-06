---
'kimaki-cli2': minor
---

Add `kimaki restart`, `kimaki profile cpu` and `kimaki profile heap` for the running bot.

```bash
kimaki restart                     # restart the bot with the code on disk
kimaki profile cpu --duration 30s  # prints <data dir>/profiles/cpu-<time>.cpuprofile
kimaki profile heap                # prints <data dir>/profiles/heap-<time>.heapsnapshot
```

- The root `kimaki` command now runs the bot in a child process and starts it again on `kimaki restart`, so a restart loads new code. Ctrl+C and `kill` still stop everything.
- Profile files are owner-only (`0600`): heap snapshots can contain the bot token.
- Ctrl+C during `profile cpu` stops the recording early; the file is still written.
